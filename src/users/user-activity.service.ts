import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, Brackets } from 'typeorm';
import { UserEntity } from './user.entity';
import { MediaMetaDataEntity } from '../media-meta-data/media-meta-data.entity';
import {
  ActivityTimeRequestDto,
  ActivityTimeResponse,
  ActivityTimeUserResult,
  ActivityTimeWindowResult,
  TimeWindowDto,
} from './user.dto';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const ids: string[] = [];
    const externalIds: string[] = [];
    for (const raw of inputs) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        throw new BadRequestException('user identifier must not be empty');
      }
      if (UUID_REGEX.test(trimmed)) {
        ids.push(trimmed);
      } else {
        externalIds.push(trimmed);
      }
    }

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
    for (const raw of inputs) {
      const u = byKey.get(raw.trim());
      if (!u || seen.has(u.id)) continue;
      seen.add(u.id);
      ordered.push({ id: u.id, external_id: u.external_id });
    }
    return ordered;
  }
}
