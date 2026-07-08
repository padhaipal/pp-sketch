import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, Brackets } from 'typeorm';
import { UserEntity } from './user.entity';
import { UserService } from './user.service';
import { MediaMetaDataEntity } from '../media-meta-data/media-meta-data.entity';
import {
  ActivityTimeRequestDto,
  ActivityTimeResponse,
  ActivityTimeUserResult,
  ActivityTimeWindowResult,
  DashboardSummaryDay,
  DashboardSummaryResponse,
  TimeWindowDto,
} from './user.dto';
import { CacheService } from '../interfaces/redis/cache';
import { CACHE_KEYS, CACHE_TTL } from '../interfaces/redis/cache.dto';
import {
  addDays,
  istDateIso,
  istMidnightUtc,
} from '../notifier/report-card/report-card.utils';

const ACTIVE_GAP_THRESHOLD_MS = 120_000;
const FIVE_MIN_MS = 5 * 60 * 1000;
// SQL fragment: IST calendar date of a timestamptz. IST is a fixed +5:30 (no
// DST) so a plain interval add matches the JS helpers in report-card.utils.
const IST_DATE_SQL = (col: string) =>
  `((${col} AT TIME ZONE 'UTC') + interval '330 minutes')::date`;

interface ParsedWindow {
  start: Date;
  end: Date;
}

interface VoiceMessageRow {
  user_id: string;
  created_at: Date;
}

@Injectable()
export class UserActivityService {
  private readonly logger = new Logger(UserActivityService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(MediaMetaDataEntity)
    private readonly mediaRepo: Repository<MediaMetaDataEntity>,
    private readonly userService: UserService,
    private readonly cacheService: CacheService,
  ) {}

  // All-user daily aggregates for the dashboard summary charts: one row per
  // IST day from the earliest record in the DB through today. Heavy full-table
  // scans, so the result is cached (past days are immutable; only today
  // drifts). Definitions mirror the per-user endpoints exactly:
  //   - active_ms / users_over_5min: computeActiveMs gap rule, expressed in
  //     SQL (gap between consecutive voice messages of the same user, both in
  //     the same IST day, 0 < gap < ACTIVE_GAP_THRESHOLD_MS)
  //   - letters_learnt: getLetterBins "learnt" bin evaluated as of each score
  //     event, so the stock rises the day the rule is first met and falls the
  //     day a regression breaks it
  async getDashboardSummary(): Promise<DashboardSummaryResponse> {
    const cacheKey = CACHE_KEYS.dashboardSummary();
    const cached =
      await this.cacheService.get<DashboardSummaryResponse>(cacheKey);
    if (cached) return cached;

    const manager = this.mediaRepo.manager;

    const [minRows, activityRows, letterRows] = await Promise.all([
      manager.query<{ min_at: Date | null }[]>(
        `SELECT LEAST(
           (SELECT MIN(created_at) FROM users),
           (SELECT MIN(created_at) FROM media_metadata)
         ) AS min_at`,
      ),
      manager.query<
        { date: string; users_over_5min: number; active_ms: string }[]
      >(
        `WITH msgs AS (
           SELECT user_id, created_at,
                  LAG(created_at) OVER (
                    PARTITION BY user_id ORDER BY created_at
                  ) AS prev_created_at
           FROM media_metadata
           WHERE user_id IS NOT NULL
             AND source = 'whatsapp'
             AND media_type = 'audio'
             AND rolled_back = false
         ),
         gaps AS (
           SELECT user_id,
                  ${IST_DATE_SQL('created_at')} AS ist_date,
                  ${IST_DATE_SQL('prev_created_at')} AS prev_ist_date,
                  EXTRACT(EPOCH FROM (created_at - prev_created_at)) * 1000
                    AS gap_ms
           FROM msgs
         ),
         per_user_day AS (
           SELECT user_id, ist_date,
                  COALESCE(SUM(gap_ms) FILTER (
                    WHERE gap_ms > 0 AND gap_ms < $1
                      AND prev_ist_date = ist_date
                  ), 0) AS active_ms
           FROM gaps
           GROUP BY user_id, ist_date
         )
         SELECT ist_date::text AS date,
                COUNT(*) FILTER (WHERE active_ms > $2)::int
                  AS users_over_5min,
                ROUND(SUM(active_ms)) AS active_ms
         FROM per_user_day
         GROUP BY ist_date
         ORDER BY ist_date`,
        [ACTIVE_GAP_THRESHOLD_MS, FIVE_MIN_MS],
      ),
      manager.query<{ date: string; learnt_delta: number }[]>(
        `WITH events AS (
           SELECT s.user_id, s.letter_id, s.score, s.created_at,
                  MAX(s.score) FILTER (WHERE s.user_message_id IS NULL)
                    OVER w AS seed_so_far,
                  COUNT(*) OVER w AS n_so_far,
                  MIN(s.score) OVER w AS min_so_far
           FROM scores s
           WINDOW w AS (
             PARTITION BY s.user_id, s.letter_id
             ORDER BY s.created_at
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           )
         ),
         states AS (
           SELECT user_id, letter_id, created_at,
                  (seed_so_far IS NOT NULL
                   AND n_so_far >= 4
                   AND score > seed_so_far
                   AND min_so_far <= seed_so_far - 4) AS learnt
           FROM events
         ),
         transitions AS (
           SELECT created_at, learnt,
                  LAG(learnt, 1, false) OVER (
                    PARTITION BY user_id, letter_id ORDER BY created_at
                  ) AS prev_learnt
           FROM states
         )
         SELECT ${IST_DATE_SQL('created_at')}::text AS date,
                SUM(CASE WHEN learnt AND NOT prev_learnt THEN 1
                         WHEN prev_learnt AND NOT learnt THEN -1
                         ELSE 0 END)::int AS learnt_delta
         FROM transitions
         WHERE learnt IS DISTINCT FROM prev_learnt
         GROUP BY 1
         ORDER BY 1`,
      ),
    ]);

    const minAt = minRows[0]?.min_at ? new Date(minRows[0].min_at) : null;
    if (minAt === null) {
      const empty: DashboardSummaryResponse = { daily: [] };
      return empty;
    }

    const activityByDate = new Map(activityRows.map((r) => [r.date, r]));
    const learntDeltaByDate = new Map(
      letterRows.map((r) => [r.date, Number(r.learnt_delta)]),
    );

    // Continuous IST-day series from the earliest record through today
    // (today is partial). letters_learnt is a running stock; the others are
    // per-day flows.
    const daily: DashboardSummaryDay[] = [];
    const todayMid = istMidnightUtc(new Date());
    let lettersStock = 0;
    for (
      let dayMid = istMidnightUtc(minAt);
      dayMid.getTime() <= todayMid.getTime();
      dayMid = addDays(dayMid, 1)
    ) {
      const date = istDateIso(dayMid);
      const activity = activityByDate.get(date);
      lettersStock += learntDeltaByDate.get(date) ?? 0;
      daily.push({
        date,
        users_over_5min: activity ? Number(activity.users_over_5min) : 0,
        active_ms: activity ? Number(activity.active_ms) : 0,
        letters_learnt: lettersStock,
      });
    }

    const response: DashboardSummaryResponse = { daily };
    await this.cacheService.set(
      cacheKey,
      response,
      CACHE_TTL.DASHBOARD_SUMMARY,
    );
    return response;
  }

  // Returns ms each user was "active" inside each window. Active ms = sum of
  // gaps between consecutive whatsapp voice messages where both messages fall
  // inside the window AND the gap is < ACTIVE_GAP_THRESHOLD_MS (120 s).
  // Windows may overlap; each is computed independently.
  async getActivityTime(
    request: ActivityTimeRequestDto,
  ): Promise<ActivityTimeResponse> {
    const parsedWindows = this.parseWindows(request.windows);
    const users = await this.resolveUsers(request.users);

    if (users.length === 0 || parsedWindows.length === 0) {
      return { results: [] };
    }

    const userIds = users.map((u) => u.id);

    // Earliest start / latest end across all windows — single fetch then bucket
    // in memory. Cheaper than N queries when windows overlap.
    const earliestStart = parsedWindows.reduce(
      (acc, w) => (w.start < acc ? w.start : acc),
      parsedWindows[0].start,
    );
    const latestEnd = parsedWindows.reduce(
      (acc, w) => (w.end > acc ? w.end : acc),
      parsedWindows[0].end,
    );

    const messagesByUser = await this.fetchVoiceMessages(
      userIds,
      earliestStart,
      latestEnd,
    );

    const results: ActivityTimeUserResult[] = users.map((user) => {
      const msgs = messagesByUser.get(user.id) ?? [];
      const windowResults: ActivityTimeWindowResult[] = parsedWindows.map(
        (w) => ({
          start: w.start.toISOString(),
          end: w.end.toISOString(),
          active_ms: this.computeActiveMs(msgs, w),
        }),
      );
      return {
        user_id: user.id,
        external_id: user.external_id,
        windows: windowResults,
      };
    });

    return { results };
  }

  private async fetchVoiceMessages(
    userIds: string[],
    earliestStart: Date,
    latestEnd: Date,
  ): Promise<Map<string, Date[]>> {
    const rows = await this.mediaRepo
      .createQueryBuilder('mm')
      .select('mm.user_id', 'user_id')
      .addSelect('mm.created_at', 'created_at')
      .where('mm.user_id IN (:...userIds)', { userIds })
      .andWhere('mm.source = :source', { source: 'whatsapp' })
      .andWhere('mm.media_type = :media_type', { media_type: 'audio' })
      .andWhere('mm.rolled_back = :rolled_back', { rolled_back: false })
      .andWhere(
        new Brackets((qb) => {
          qb.where('mm.created_at >= :earliestStart', {
            earliestStart,
          }).andWhere('mm.created_at <= :latestEnd', { latestEnd });
        }),
      )
      .orderBy('mm.user_id', 'ASC')
      .addOrderBy('mm.created_at', 'ASC')
      .getRawMany<VoiceMessageRow>();

    const messagesByUser = new Map<string, Date[]>();
    for (const row of rows) {
      const ts =
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at);
      if (!messagesByUser.has(row.user_id)) {
        messagesByUser.set(row.user_id, []);
      }
      messagesByUser.get(row.user_id)!.push(ts);
    }
    return messagesByUser;
  }

  // Returns the user's active_ms since today's IST midnight, both including
  // and excluding the most recent whatsapp voice message. Comparing the two
  // lets a caller detect a threshold crossing caused by the latest turn
  // (withoutLatestTurn < T && withLatestTurn >= T) exactly once per day.
  // Values are milliseconds; fewer than 2 messages today → both 0.
  async getTodayActiveTime(user_id: string): Promise<{
    withLatestTurn: number;
    withoutLatestTurn: number;
  }> {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const now = new Date();
    const istNow = new Date(now.getTime() + IST_OFFSET_MS);
    const istMidnight = new Date(
      Date.UTC(
        istNow.getUTCFullYear(),
        istNow.getUTCMonth(),
        istNow.getUTCDate(),
      ),
    );
    const midnight = new Date(istMidnight.getTime() - IST_OFFSET_MS);

    const byUser = await this.fetchVoiceMessages([user_id], midnight, now);
    const msgs = byUser.get(user_id) ?? [];

    const window: ParsedWindow = { start: midnight, end: now };
    return {
      withLatestTurn: this.computeActiveMs(msgs, window),
      withoutLatestTurn: this.computeActiveMs(msgs.slice(0, -1), window),
    };
  }

  private computeActiveMs(sortedMsgs: Date[], window: ParsedWindow): number {
    if (sortedMsgs.length < 2) return 0;
    const startMs = window.start.getTime();
    const endMs = window.end.getTime();

    let active = 0;
    let prev: number | null = null;
    for (const msg of sortedMsgs) {
      const t = msg.getTime();
      if (t < startMs || t > endMs) {
        prev = null;
        continue;
      }
      if (prev !== null) {
        const gap = t - prev;
        if (gap > 0 && gap < ACTIVE_GAP_THRESHOLD_MS) {
          active += gap;
        }
      }
      prev = t;
    }
    return active;
  }

  private parseWindows(windows: TimeWindowDto[]): ParsedWindow[] {
    return windows.map((w, idx) => {
      const start = new Date(w.start);
      const end = new Date(w.end);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new BadRequestException(
          `windows[${idx}]: start/end must be valid ISO 8601 datetimes`,
        );
      }
      if (start > end) {
        throw new BadRequestException(`windows[${idx}]: start must be <= end`);
      }
      return { start, end };
    });
  }

  private async resolveUsers(
    inputs: string[],
  ): Promise<{ id: string; external_id: string }[]> {
    const { ids, externalIds, canonical } =
      this.userService.partitionIdentifiers(inputs);

    const found: UserEntity[] = [];
    if (ids.length > 0) {
      found.push(...(await this.userRepo.find({ where: { id: In(ids) } })));
    }
    if (externalIds.length > 0) {
      found.push(
        ...(await this.userRepo.find({
          where: { external_id: In(externalIds) },
        })),
      );
    }

    // Preserve input order, dedupe.
    const byKey = new Map<string, UserEntity>();
    for (const u of found) {
      byKey.set(u.id, u);
      byKey.set(u.external_id, u);
    }
    const seen = new Set<string>();
    const ordered: { id: string; external_id: string }[] = [];
    for (const key of canonical) {
      const u = byKey.get(key);
      if (!u || seen.has(u.id)) continue;
      seen.add(u.id);
      ordered.push({ id: u.id, external_id: u.external_id });
    }
    return ordered;
  }
}
