import { Logger } from '@nestjs/common';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Job } from 'bullmq';
import type { DataSource, Repository } from 'typeorm';
import { createQueue, QUEUE_NAMES } from '../interfaces/redis/queues';
import type { OutboundMediaItem } from '../interfaces/wabot/outbound/outbound.dto';
import type { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';
import type { MediaMetaDataService } from '../media-meta-data/media-meta-data.service';
import { MediaMetaDataEntity } from '../media-meta-data/media-meta-data.entity';
import type { ReportCardService } from './report-card/report-card.service';
import { tracer, injectCarrier, startChildSpan } from '../otel/otel';
import { toLogId } from '../otel/pii';
import { getActiveUsers } from './notifier.utils';
import { istMidnightUtc } from './report-card/report-card.utils';

const logger = new Logger('MorningUpdateProcessor');

export interface MorningUpdateSendJobData {
  user_id: string;
  user_external_id: string;
  // Pre-resolved media to send before the per-user report card image. Mirrors
  // evening-reminder's "intro media first, custom payload second" pattern.
  media: OutboundMediaItem[];
  // OTel carrier so the worker can stitch its span back to the cron span.
  otel_carrier: Record<string, string>;
}

export async function processMorningUpdateCronJob(
  job: Job,
  dataSource: DataSource,
  mediaMetaDataService: MediaMetaDataService,
): Promise<void> {
  return tracer.startActiveSpan('morning-update.cron', async (span) => {
    span.setAttribute('bullmq.job.id', String(job.id));
    try {
      const now = new Date();
      const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const idleSince = new Date(now.getTime() - 5 * 60 * 1000);
      span.setAttribute('morning_update.window.start', windowStart.toISOString());
      span.setAttribute('morning_update.idle_since', idleSince.toISOString());

      const activeUsers = await getActiveUsers(dataSource, {
        windowStart,
        idleSince,
      });
      span.setAttribute('morning_update.active_users.count', activeUsers.length);
      if (activeUsers.length === 0) {
        logger.log('No active users — skipping morning update.');
        return;
      }

      // Pick the morning-notification-message preloaded media. We send it as
      // the first item, followed by the per-user report card image (resolved
      // in the worker once it's 'ready').
      const introMedia =
        await mediaMetaDataService.findMediaByStateTransitionId(
          'morning_notification_message',
        );
      const introItems: OutboundMediaItem[] = [];
      const introImage = introMedia.image;
      const introVideo = introMedia.video;
      if (introVideo) {
        introItems.push({
          type: 'video',
          url: introVideo.wa_media_url!,
          mime_type: (introVideo.media_details as { mime_type?: string } | null)
            ?.mime_type,
        });
      } else if (introImage) {
        introItems.push({
          type: 'image',
          url: introImage.wa_media_url!,
          mime_type: (introImage.media_details as { mime_type?: string } | null)
            ?.mime_type,
        });
      } else {
        logger.error(
          'No morning_notification_message media (image or video) found with status=ready — aborting.',
        );
        span.setAttribute('morning_update.skip_reason', 'no-intro-media');
        return;
      }

      const sendQueue = createQueue(QUEUE_NAMES.MORNING_UPDATE_SEND);
      const otel_carrier = injectCarrier(span);

      for (const u of activeUsers) {
        const data: MorningUpdateSendJobData = {
          user_id: u.user_id,
          user_external_id: u.external_id,
          media: introItems,
          otel_carrier,
        };
        await sendQueue.add('morning-update-send', data);
      }
      span.setAttribute('morning_update.enqueued.count', activeUsers.length);
      logger.log(
        `Enqueued ${String(activeUsers.length)} morning-update jobs.`,
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

// Throwing this signals "requeue with the queue's fixed-1s backoff". We use a
// distinct Error subclass so unrelated failures still surface as ERRORs.
class RequeueRequestedError extends Error {
  constructor(reason: string) {
    super(`requeue: ${reason}`);
    this.name = 'RequeueRequestedError';
  }
}

export async function processMorningUpdateSendJob(
  job: Job<MorningUpdateSendJobData>,
  reportCardService: ReportCardService,
  mediaMetaDataService: MediaMetaDataService,
  mediaRepo: Repository<MediaMetaDataEntity>,
  wabotOutbound: WabotOutboundService,
): Promise<void> {
  const span = startChildSpan('morning-update.send', job.data.otel_carrier);
  span.setAttribute('bullmq.job.id', String(job.id));
  span.setAttribute(
    'morning_update.user.external_id_hash',
    toLogId(job.data.user_external_id),
  );

  try {
    const today = istMidnightUtc(new Date());
    const existing = await reportCardService.findExistingForUser(
      job.data.user_id,
      today,
    );

    let imageEntity: MediaMetaDataEntity | null = null;

    if (existing) {
      // Re-read the row in case status moved on (preload completed).
      imageEntity = await mediaRepo.findOneBy({ id: existing.id });
    }

    if (imageEntity === null) {
      // First time the worker has seen this user today — render and persist.
      const { buffer } = await reportCardService.generatePng(job.data.user_id);
      const created = await mediaMetaDataService.createRenderedImageMedia({
        buffer,
        mime_type: 'image/png',
        user_id: job.data.user_id,
        source: 'morning-update',
        otel_carrier: injectCarrier(span),
      });
      span.setAttribute('morning_update.image.created', true);
      // Status will be 'queued' here — the preload worker drives it to 'ready'.
      // Requeue so we re-check; queue defaults give us a 1 s gap.
      throw new RequeueRequestedError(
        `report card image for ${toLogId(job.data.user_external_id)} just created (status=${created.status})`,
      );
    }

    if (imageEntity.status === 'failed') {
      logger.error(
        `Morning-update report card media ${imageEntity.id} for user ${toLogId(job.data.user_external_id)} status=failed — skipping`,
      );
      span.setAttribute('morning_update.skip_reason', 'image-failed');
      return;
    }

    if (imageEntity.status !== 'ready' || !imageEntity.wa_media_url) {
      span.setAttribute('morning_update.image.status', imageEntity.status);
      throw new RequeueRequestedError(
        `report card status=${imageEntity.status}`,
      );
    }

    const fullMedia: OutboundMediaItem[] = [
      ...job.data.media,
      {
        type: 'image',
        url: imageEntity.wa_media_url,
        mime_type: 'image/png',
      },
    ];

    const result = await wabotOutbound.sendNotification({
      user_external_id: job.data.user_external_id,
      media: fullMedia,
    });

    if (result.error_code !== undefined) {
      span.setAttribute('wabot.error_code', result.error_code);
    }
    if (result.error_code === 130429) {
      throw new Error(
        `WhatsApp rate-limit (130429) for user ${toLogId(job.data.user_external_id)} — will retry`,
      );
    }
    if (result.error_code === 131047) {
      logger.warn(
        `Morning-update undeliverable: 24h window expired (131047) for user ${toLogId(job.data.user_external_id)}`,
      );
      span.setAttribute('morning_update.skip_reason', 'window-expired');
      return;
    }
    if (!result.delivered) {
      throw new Error(
        `Morning-update failed for user ${toLogId(job.data.user_external_id)}: status=${String(result.status)} error_code=${String(result.error_code)}`,
      );
    }
    logger.log(
      `Morning-update delivered to user ${toLogId(job.data.user_external_id)}`,
    );
  } catch (err) {
    if (err instanceof RequeueRequestedError) {
      span.setAttribute('morning_update.requeue', true);
    } else {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      span.recordException(err as Error);
    }
    throw err;
  } finally {
    span.end();
  }
}