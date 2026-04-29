import { Logger } from '@nestjs/common';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import { createQueue, QUEUE_NAMES } from '../interfaces/redis/queues';
import type { OutboundMediaItem } from '../interfaces/wabot/outbound/outbound.dto';
import type { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';
import type { LiteracyLessonService } from '../literacy/literacy-lesson/literacy-lesson.service';
import type { MediaMetaDataService } from '../media-meta-data/media-meta-data.service';
import type { FindMediaByStateTransitionIdResult } from '../media-meta-data/media-meta-data.dto';
import { tracer, injectCarrier } from '../otel/otel';
import type { OtelCarrier } from '../otel/otel.dto';
import { toLogId } from '../otel/pii';
import type { UserService } from '../users/user.service';
import type { User } from '../users/user.dto';

const logger = new Logger('HailMaryProcessor');

export const HAIL_MARY_DELAY_MS = 1435 * 60 * 1000; // 23h55m
export const HAIL_MARY_STATE_TRANSITION_ID = 'hail-mary';

export interface HailMaryJobData {
  user_id: string;
  user_external_id: string;
  user_message_id: string;
  otel_carrier: OtelCarrier;
}

export async function rearmHailMary(args: HailMaryJobData): Promise<void> {
  const queue = createQueue(QUEUE_NAMES.HAIL_MARY);
  const jobId = `hail-mary:${args.user_id}`;
  await queue.remove(jobId);
  await queue.add('hail-mary', args, {
    jobId,
    delay: HAIL_MARY_DELAY_MS,
  });
}

interface LatestUserMessageRow {
  id: string;
  created_at: Date;
}

export async function processHailMaryJob(
  job: Job<HailMaryJobData>,
  dataSource: DataSource,
  userService: UserService,
  mediaMetaDataService: MediaMetaDataService,
  literacyLessonService: LiteracyLessonService,
  wabotOutbound: WabotOutboundService,
): Promise<void> {
  return tracer.startActiveSpan('hail-mary.send', async (span) => {
    span.setAttribute('bullmq.job.id', String(job.id));
    span.setAttribute('user_id_hash', toLogId(job.data.user_external_id));
    span.setAttribute('source_msg_id_hash', toLogId(job.data.user_message_id));

    try {
      // Latest whatsapp message for user (re-derive rolled_back filter per
      // project conventions — services encode this for entity reads).
      const rows: LatestUserMessageRow[] = await dataSource.query(
        `SELECT id, created_at FROM media_metadata
         WHERE user_id = $1
           AND source = 'whatsapp'
           AND rolled_back = false
         ORDER BY created_at DESC
         LIMIT 1`,
        [job.data.user_id],
      );
      const latest = rows[0];
      if (!latest) {
        logger.warn(
          `hail-mary: no whatsapp messages for user ${toLogId(job.data.user_external_id)} — skipping`,
        );
        span.setAttribute('hail_mary.skip_reason', 'no-latest-message');
        return;
      }

      // Staleness — a newer user message exists; this scheduled run is no
      // longer the tail of the chain. Re-rearm against the latest message
      // unless another delayed job is already queued.
      if (latest.id !== job.data.user_message_id) {
        logger.warn(
          `hail-mary: rearm chain broke for user ${toLogId(job.data.user_external_id)}`,
        );
        span.setAttribute('hail_mary.skip_reason', 'stale');

        const queue = createQueue(QUEUE_NAMES.HAIL_MARY);
        const jobId = `hail-mary:${job.data.user_id}`;
        const existing = await queue.getJob(jobId);
        // Self exclusion: while this worker runs, the active job carries the
        // same jobId. Treat 'active' as no delayed job present.
        const existingState = existing
          ? await existing.getState().catch(() => 'unknown')
          : null;
        if (!existing || existingState === 'active') {
          await rearmHailMary({
            user_id: job.data.user_id,
            user_external_id: job.data.user_external_id,
            user_message_id: latest.id,
            otel_carrier: injectCarrier(span),
          });
        }
        return;
      }

      // 24h window expired — user activity (a fresh inbound message) is the
      // only thing that should rearm us. Defensive guard for clock skew.
      const ageMs = Date.now() - new Date(latest.created_at).getTime();
      if (ageMs >= 24 * 60 * 60 * 1000) {
        logger.warn(
          `hail-mary: 24h window expired for user ${toLogId(job.data.user_external_id)}`,
        );
        span.setAttribute('hail_mary.skip_reason', 'window-expired');
        return;
      }

      // Resolve user (needed for processAnswer).
      const user = await userService.find({ id: job.data.user_id });
      if (!user) {
        logger.warn(
          `hail-mary: user ${toLogId(job.data.user_external_id)} not found — skipping`,
        );
        span.setAttribute('hail_mary.skip_reason', 'user-not-found');
        return;
      }

      // Build media — tolerant: each step in own try/catch; never abort.
      const media: OutboundMediaItem[] = [];

      try {
        const hailMaryMedia =
          await mediaMetaDataService.findMediaByStateTransitionId(
            HAIL_MARY_STATE_TRANSITION_ID,
          );
        if (hailMaryMedia.video) {
          appendMediaItems(media, { video: hailMaryMedia.video });
        }
      } catch (err) {
        logger.warn(
          `hail-mary: fetch hail-mary stid media failed: ${(err as Error).message}`,
        );
      }

      try {
        const lessonResult = await literacyLessonService.processAnswer({
          user: user as User,
          user_message_id: latest.id,
        });
        for (const stid of lessonResult.stateTransitionIds) {
          try {
            const lessonMedia =
              await mediaMetaDataService.findMediaByStateTransitionId(stid);
            appendMediaItems(media, lessonMedia);
          } catch (err) {
            logger.warn(
              `hail-mary: fetch lesson stid="${stid}" media failed: ${(err as Error).message}`,
            );
          }
        }
      } catch (err) {
        logger.warn(
          `hail-mary: processAnswer failed for user ${toLogId(job.data.user_external_id)}: ${(err as Error).message}`,
        );
      }

      if (media.length === 0) {
        logger.warn(
          `hail-mary: no media to send for user ${toLogId(job.data.user_external_id)}`,
        );
        span.setAttribute('hail_mary.skip_reason', 'no-media');
        return;
      }

      const result = await wabotOutbound.sendMessage({
        user_external_id: job.data.user_external_id,
        wamid: '',
        media,
        otel_carrier: injectCarrier(span),
      });
      span.setAttribute('http.response.status_code', result.status);
      logger.log(
        `hail-mary: sent to user ${toLogId(job.data.user_external_id)} status=${result.status}`,
      );
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

function appendMediaItems(
  items: OutboundMediaItem[],
  media: FindMediaByStateTransitionIdResult,
): void {
  for (const type of ['video', 'audio', 'image', 'sticker', 'text'] as const) {
    const entity = media[type];
    if (!entity) continue;
    if (type === 'text') {
      items.push({ type: 'text', body: entity.text! });
    } else {
      const mime_type = (entity.media_details as { mime_type?: string } | null)
        ?.mime_type;
      items.push({ type, url: entity.wa_media_url!, mime_type });
    }
  }
}

