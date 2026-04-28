import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import sharp from 'sharp';
import { UserService } from '../../users/user.service';
import { UserActivityService } from '../../users/user-activity.service';
import { ScoreService } from '../../literacy/score/score.service';
import type { LettersLearntResult } from '../../literacy/score/score.dto';
import { MediaMetaDataEntity } from '../../media-meta-data/media-meta-data.entity';
import type { MediaMetaData } from '../../media-meta-data/media-meta-data.dto';
import {
  addDays,
  istDateIso,
  istMidnightUtc,
  istWeekday,
} from './report-card.utils';
import {
  DailyBar,
  ReportCardData,
} from './report-card.dto';
import { buildReportCardSvg } from './report-card.svg';

interface BuildOptions {
  // Override for testing — defaults to "now". The cron at 7 AM IST runs with
  // now ≈ 01:30 UTC (= 07:00 IST), so istMidnightUtc(now) is today's IST midnight.
  now?: Date;
}

@Injectable()
export class ReportCardService {
  constructor(
    private readonly userService: UserService,
    private readonly userActivityService: UserActivityService,
    private readonly scoreService: ScoreService,
    @InjectRepository(MediaMetaDataEntity)
    private readonly mediaRepo: Repository<MediaMetaDataEntity>,
  ) {}

  // Pure: gather DB data → build a PNG buffer. Used both by the dashboard
  // preview controller and the morning-update worker.
  async generatePng(
    userIdOrExternal: string,
    options: BuildOptions = {},
  ): Promise<{ buffer: Buffer; data: ReportCardData }> {
    const data = await this.buildData(userIdOrExternal, options);
    const svg = await buildReportCardSvg(data);
    const buffer = await sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
    return { buffer, data };
  }

  // Build the raw data without rendering. Exposed so tests can verify the
  // edge-case logic without depending on librsvg/font availability.
  async buildData(
    userIdOrExternal: string,
    options: BuildOptions = {},
  ): Promise<ReportCardData> {
    const user = await this.resolveUser(userIdOrExternal);

    const now = options.now ?? new Date();
    const todayMid = istMidnightUtc(now); // 00:00 IST today
    const yesterdayMid = addDays(todayMid, -1); // 00:00 IST yesterday
    const weekAgoMid = addDays(todayMid, -7); // 00:00 IST 7 days ago

    // Letters learnt as of end-of-yesterday (= today IST midnight) — "not this morning".
    const learntEndOfYesterday = (await this.scoreService.getLettersLearnt(
      user.id,
      { asOf: todayMid },
    )) as LettersLearntResult;
    // Baseline: letters learnt as of start-of-yesterday.
    const learntStartOfYesterday = (await this.scoreService.getLettersLearnt(
      user.id,
      { asOf: yesterdayMid },
    )) as LettersLearntResult;

    const previous = new Set(learntStartOfYesterday.lettersLearnt);
    const yesterdayDelta = learntEndOfYesterday.lettersLearnt.filter(
      (g) => !previous.has(g),
    );

    // Activity time per IST day for the last 7 IST days, ending yesterday.
    // Day i (0..6) covers [weekAgoMid + i*24h, weekAgoMid + (i+1)*24h).
    const windows = Array.from({ length: 7 }, (_, i) => {
      const start = addDays(weekAgoMid, i);
      const end = addDays(start, 1);
      return { start: start.toISOString(), end: end.toISOString() };
    });

    const activity = await this.userActivityService.getActivityTime({
      users: [user.id],
      windows,
    });

    const userActivity = activity.results[0];
    const daily: DailyBar[] = windows.map((w, i) => {
      const start = addDays(weekAgoMid, i);
      return {
        date_iso: istDateIso(start),
        day_index: istWeekday(start),
        active_ms: userActivity?.windows[i]?.active_ms ?? 0,
      };
    });

    return {
      user_external_id: user.external_id,
      letters_learnt: learntEndOfYesterday.lettersLearnt,
      letters_learnt_yesterday: yesterdayDelta,
      daily_bars: daily,
    };
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
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrExternalId,
      );
    const user = await this.userService.find(
      isUuid ? { id: idOrExternalId } : { external_id: idOrExternalId },
    );
    if (!user) {
      throw new NotFoundException(`User not found: ${idOrExternalId}`);
    }
    return { id: user.id, external_id: user.external_id };
  }
}