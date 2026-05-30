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
  TimeWindowDto,
} from './user.dto';

const ACTIVE_GAP_THRESHOLD_MS = 60_000;

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
  ) {}

  // Returns ms each user was "active" inside each window. Active ms = sum of
  // gaps between consecutive whatsapp voice messages where both messages fall
  // inside the window AND the gap is < 60 s. Windows may overlap; each is
  // computed independently.
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

  // Returns true iff the most recent whatsapp voice message just pushed the
  // user's active_ms (since today's IST midnight) over `threshold_ms`. False
  // if the threshold had already been crossed by an earlier message today, or
  // not yet crossed. Self-deduplicating: fires exactly once per day per user.
  async didJustCrossDailyActivityThreshold(args: {
    user_id: string;
    threshold_ms: number;
  }): Promise<boolean> {
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

    const byUser = await this.fetchVoiceMessages([args.user_id], midnight, now);
    const msgs = byUser.get(args.user_id) ?? [];
    if (msgs.length < 2) return false;

    const window: ParsedWindow = { start: midnight, end: now };
    const after = this.computeActiveMs(msgs, window);
    const before = this.computeActiveMs(msgs.slice(0, -1), window);
    return before <= args.threshold_ms && after > args.threshold_ms;
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
