import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import sharp from 'sharp';
import { UserService } from '../../users/user.service';
import { UserActivityService } from '../../users/user-activity.service';
import { MediaMetaDataEntity } from '../../media-meta-data/media-meta-data.entity';
import type { MediaMetaData } from '../../media-meta-data/media-meta-data.dto';
import { addDays, istMidnightUtc } from './report-card.utils';
import {
  levelBand,
  minutesOf,
  pickPraise,
  ReportCardData,
  timeBand,
} from './report-card.dto';
import { buildReportCardSvg } from './report-card.svg';

interface BuildOptions {
  // Override for testing — defaults to "now". The cron at 7 AM IST runs with
  // now ≈ 01:30 UTC (= 07:00 IST), so istMidnightUtc(now) is today's IST
  // midnight and the card is about the IST day before it.
  now?: Date;
}

@Injectable()
export class ReportCardService {
  constructor(
    private readonly userService: UserService,
    private readonly userActivityService: UserActivityService,
    private readonly dataSource: DataSource,
    @InjectRepository(MediaMetaDataEntity)
    private readonly mediaRepo: Repository<MediaMetaDataEntity>,
  ) {}

  // Pure: gather DB data → build a PNG buffer. Used by both the swagger
  // preview controller and the morning-update worker.
  async generatePng(
    userIdOrExternal: string,
    options: BuildOptions = {},
  ): Promise<{ buffer: Buffer; data: ReportCardData }> {
    const data = await this.buildData(userIdOrExternal, options);
    const svg = buildReportCardSvg(data);
    const buffer = await sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
    return { buffer, data };
  }

  // Yesterday's (IST) figures. Exposed so tests can verify the data logic
  // without librsvg / font availability.
  async buildData(
    userIdOrExternal: string,
    options: BuildOptions = {},
  ): Promise<ReportCardData> {
    const user = await this.resolveUser(userIdOrExternal);
    const now = options.now ?? new Date();
    const todayMid = istMidnightUtc(now); // 00:00 IST today = end of yesterday
    const yesterdayMid = addDays(todayMid, -1); // 00:00 IST yesterday

    const [activity, levels, letters] = await Promise.all([
      this.userActivityService.getActivityTime({
        users: [user.id],
        windows: [
          { start: yesterdayMid.toISOString(), end: todayMid.toISOString() },
        ],
      }),
      this.levelsAround(user.id, yesterdayMid, todayMid),
      this.topLetters(user.id, yesterdayMid, todayMid),
    ]);
    const activeMs = activity.results[0]?.windows[0]?.active_ms ?? 0;
    const levelDelta =
      levels.level_end !== null && levels.level_start !== null
        ? levels.level_end - levels.level_start
        : 0;
    const tBand = timeBand(activeMs);
    const dayNumber = Math.floor(yesterdayMid.getTime() / 86_400_000);
    return {
      user_external_id: user.external_id,
      active_ms: activeMs,
      minutes: minutesOf(activeMs),
      time_band: tBand,
      level_delta: levelDelta,
      level_band: levelBand(levelDelta),
      top_letters: letters,
      praise: pickPraise(tBand, user.id, dayNumber),
    };
  }

  // The student's lesson level (the cap the last lesson was selected at,
  // literacy_lesson_states.level) as of the end of yesterday and of the day
  // before — the newest non-null value before each cut-off. Null until the
  // first lesson with a level.
  private async levelsAround(
    userId: string,
    yesterdayMid: Date,
    todayMid: Date,
  ): Promise<{ level_end: number | null; level_start: number | null }> {
    const rows: Array<{
      level_end: number | string | null;
      level_start: number | string | null;
    }> = await this.dataSource.query(
      `/* report-card:levels */
       SELECT
         (SELECT level FROM literacy_lesson_states
           WHERE user_id = $1 AND level IS NOT NULL AND created_at < $2
           ORDER BY created_at DESC LIMIT 1) AS level_end,
         (SELECT level FROM literacy_lesson_states
           WHERE user_id = $1 AND level IS NOT NULL AND created_at < $3
           ORDER BY created_at DESC LIMIT 1) AS level_start`,
      [userId, todayMid, yesterdayMid],
    );
    const num = (v: number | string | null | undefined): number | null =>
      v === null || v === undefined ? null : Number(v);
    return {
      level_end: num(rows[0]?.level_end),
      level_start: num(rows[0]?.level_start),
    };
  }

  // The three letters scored most often yesterday — scores written by the
  // child's own (not rolled-back) messages; the onboarding seed scores have
  // no message and never count.
  private async topLetters(
    userId: string,
    yesterdayMid: Date,
    todayMid: Date,
  ): Promise<string[]> {
    const rows: Array<{ grapheme: string }> = await this.dataSource.query(
      `/* report-card:letters */
       SELECT l.grapheme, count(*)::int AS n
       FROM scores s
       JOIN letters l ON l.id = s.letter_id
       JOIN media_metadata m ON m.id = s.user_message_id AND m.rolled_back = false
       WHERE s.user_id = $1 AND s.created_at >= $2 AND s.created_at < $3
       GROUP BY l.grapheme
       ORDER BY n DESC, l.grapheme
       LIMIT 3`,
      [userId, yesterdayMid, todayMid],
    );
    return rows.map((r) => r.grapheme);
  }

  // Look up an existing morning-update report card image for `userId` created
  // since `since` (i.e. today's run). Returns the entity or null.
  async findExistingForUser(
    userId: string,
    since: Date,
  ): Promise<MediaMetaData | null> {
    const row = await this.mediaRepo
      .createQueryBuilder('mm')
      .where('mm.user_id = :userId', { userId })
      .andWhere('mm.source = :source', { source: 'morning-update' })
      .andWhere('mm.media_type = :media_type', { media_type: 'image' })
      .andWhere('mm.rolled_back = :rolled_back', { rolled_back: false })
      .andWhere('mm.created_at >= :since', { since })
      .orderBy('mm.created_at', 'DESC')
      .getOne();
    return row ?? null;
  }

  private async resolveUser(idOrExternalId: string): Promise<{
    id: string;
    external_id: string;
  }> {
    const user = await this.userService.findByIdOrExternalId(idOrExternalId);
    if (!user) {
      throw new NotFoundException(`User not found: ${idOrExternalId}`);
    }
    return { id: user.id, external_id: user.external_id };
  }
}
