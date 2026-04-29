import { Logger, NotFoundException } from '@nestjs/common';
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
import type { UserService } from '../users/user.service';
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

// Resolves the intro OutboundMediaItem[] that prefixes every morning-update
// send. Prefers video over image. Returns null if neither is ready (caller
// decides whether to abort or surface as an error).
export async function resolveMorningUpdateIntroMedia(
  mediaMetaDataService: MediaMetaDataService,
): Promise<OutboundMediaItem[] | null> {
  const introMedia = await mediaMetaDataService.findMediaByStateTransitionId(
    'morning_notification_message',
  );
  const introVideo = introMedia.video;
  const introImage = introMedia.image;
  if (introVideo) {
    return [
      {
        type: 'video',
        url: introVideo.wa_media_url!,
        mime_type: (introVideo.media_details as { mime_type?: string } | null)
          ?.mime_type,
      },
    ];
  }
  if (introImage) {
    return [
      {
        type: 'image',
        url: introImage.wa_media_url!,
        mime_type: (introImage.media_details as { mime_type?: string } | null)
          ?.mime_type,
      },
    ];
  }
  return null;
}

// Push a single user's morning-update onto MORNING_UPDATE_SEND. Used by both
// the cron loop and the test/trigger endpoint.
export async function enqueueMorningUpdateSend(args: {
  user_id: string;
  user_external_id: string;
  intro_media: OutboundMediaItem[];
  otel_carrier: Record<string, string>;
}): Promise<string> {
  const sendQueue = createQueue(QUEUE_NAMES.MORNING_UPDATE_SEND);
  const data: MorningUpdateSendJobData = {
    user_id: args.user_id,
    user_external_id: args.user_external_id,
    media: args.intro_media,
    otel_carrier: args.otel_carrier,
  };
  const job = await sendQueue.add('morning-update-send', data);
  return String(job.id);
}

// Resolve a user (uuid or E.164 external_id) and enqueue a single
// morning-update send for them. Used by the trigger controller.
export async function triggerMorningUpdateForUser(
  userIdOrExternal: string,
  userService: UserService,
  mediaMetaDataService: MediaMetaDataService,
): Promise<{ job_id: string; user_id: string; user_external_id: string }> {
  return tracer.startActiveSpan('morning-update.trigger', async (span) => {
    try {
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          userIdOrExternal,
        );
      const user = await userService.find(
        isUuid
          ? { id: userIdOrExternal }
          : { external_id: userIdOrExternal },
      );
      if (!user) {
        throw new NotFoundException(
          `User not found for ${toLogId(userIdOrExternal)}`,
        );
      }
      const introItems = await resolveMorningUpdateIntroMedia(
        mediaMetaDataService,
      );
      if (!introItems) {
        throw new Error(
          'No morning_notification_message media (image or video) found with status=ready',
        );
      }
      const job_id = await enqueueMorningUpdateSend({
        user_id: user.id,
        user_external_id: user.external_id,
        intro_media: introItems,
        otel_carrier: injectCarrier(span),
      });
      span.setAttribute(
        'morning_update.user.external_id_hash',
        toLogId(user.external_id),
      );
      span.setAttribute('bullmq.job.id', job_id);
      logger.log(
        `Triggered morning-update for user ${toLogId(user.external_id)} job=${job_id}`,
      );
      return {
        job_id,
        user_id: user.id,
        user_external_id: user.external_id,
      };
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

      const introItems = await resolveMorningUpdateIntroMedia(
        mediaMetaDataService,
      );
      if (!introItems) {
        logger.error(
          'No morning_notification_message media (image or video) found with status=ready — aborting.',
        );
        span.setAttribute('morning_update.skip_reason', 'no-intro-media');
        return;
      }

      const otel_carrier = injectCarrier(span);
      for (const u of activeUsers) {
        await enqueueMorningUpdateSend({
          user_id: u.user_id,
          user_external_id: u.external_id,
          intro_media: introItems,
          otel_carrier,
        });
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

    const referralUrl = `https://dashboard.padhaipal.com/r/${job.data.user_external_id}`;
    const fullMedia: OutboundMediaItem[] = [
      ...job.data.media,
      {
        type: 'image',
        url: imageEntity.wa_media_url,
        mime_type: 'image/png',
      },
      // Tappable referral link as a follow-up text. pp-dashboard's /r/:id
      // route 302-redirects to the same wa.me URL the QR code encodes.
      { type: 'text', body: referralUrl },
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