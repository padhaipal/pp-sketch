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
import { tracer } from '../otel/otel';
import { toLogId } from '../otel/pii';
import type { User } from '../users/user.dto';
import { getActiveUsers, type ActiveUser } from './notifier.utils';

const logger = new Logger('NotifierProcessor');

export interface NotifierSendJobData {
  user_external_id: string;
  media: OutboundMediaItem[];
}

export async function processNotifierCronJob(
  job: Job,
  dataSource: DataSource,
  literacyLessonService: LiteracyLessonService,
  mediaMetaDataService: MediaMetaDataService,
): Promise<void> {
  return tracer.startActiveSpan('notifier.cron', async (span) => {
    span.setAttribute('bullmq.job.id', String(job.id));
    try {
      const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const idleSince = new Date(Date.now() - 5 * 60 * 1000);
      span.setAttribute('notifier.window.start', windowStart.toISOString());
      span.setAttribute('notifier.idle_since', idleSince.toISOString());
      logger.log(
        `Notifier cron fired. Window: ${windowStart.toISOString()} – ${idleSince.toISOString()}`,
      );

      const activeUsers: ActiveUser[] = await getActiveUsers(dataSource, {
        windowStart,
        idleSince,
      });
      span.setAttribute('notifier.active_users.count', activeUsers.length);

      if (activeUsers.length === 0) {
        span.setAttribute('notifier.skip_reason', 'no-active-users');
        logger.log('No active users found in notification window — skipping.');
        return;
      }

      const videoUrls: { wa_media_url: string }[] = await dataSource.query(
        `SELECT wa_media_url
         FROM media_metadata
         WHERE state_transition_id = 'evening_notification_message'
           AND media_type = 'video'
           AND status = 'ready'
           AND wa_media_url IS NOT NULL`,
      );
      span.setAttribute('notifier.videos.count', videoUrls.length);

      if (videoUrls.length === 0) {
        span.setAttribute('notifier.skip_reason', 'no-videos');
        logger.error(
          'No evening_notification_message videos found with status=ready — aborting notification run.',
        );
        return;
      }

      const notificationVideoUrls = videoUrls.map((r) => r.wa_media_url);

      // Sort by 24-hour expiry ascending (soonest-expiring first).
      // Expiry = last_message_at + 24h, so sorting by last_message_at ascending is equivalent.
      activeUsers.sort(
        (a, b) =>
          new Date(a.last_message_at).getTime() -
          new Date(b.last_message_at).getTime(),
      );

      const sendQueue = createQueue(QUEUE_NAMES.NOTIFIER_SEND);

      for (const activeUser of activeUsers) {
        const media = await buildUserMedia(
          activeUser,
          notificationVideoUrls,
          literacyLessonService,
          mediaMetaDataService,
        );

        const jobData: NotifierSendJobData = {
          user_external_id: activeUser.external_id,
          media,
        };
        await sendQueue.add('send-notification', jobData);
      }

      span.setAttribute('notifier.enqueued.count', activeUsers.length);
      logger.log(
        `Enqueued ${String(activeUsers.length)} notification-send jobs from ${String(notificationVideoUrls.length)} video(s).`,
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

async function buildUserMedia(
  activeUser: ActiveUser,
  notificationVideoUrls: string[],
  literacyLessonService: LiteracyLessonService,
  mediaMetaDataService: MediaMetaDataService,
): Promise<OutboundMediaItem[]> {
  return tracer.startActiveSpan('notifier.buildUserMedia', async (span) => {
    span.setAttribute(
      'notifier.user.external_id_hash',
      toLogId(activeUser.external_id),
    );
    try {
      const media: OutboundMediaItem[] = [];

      const randomUrl =
        notificationVideoUrls[
          Math.floor(Math.random() * notificationVideoUrls.length)
        ];
      media.push({ type: 'video', url: randomUrl });

      try {
        const lessonResult = await literacyLessonService.processAnswer({
          user: {
            id: activeUser.user_id,
            external_id: activeUser.external_id,
          } as User,
          user_message_id: activeUser.last_message_id,
        });

        for (const stid of lessonResult.stateTransitionIds) {
          const lessonMedia =
            await mediaMetaDataService.findMediaByStateTransitionId(stid);
          appendMediaItems(media, lessonMedia);
        }
        span.setAttribute('notifier.lesson.status', 'ok');
      } catch (err) {
        span.setAttribute('notifier.lesson.status', 'failed');
        span.recordException(err as Error);
        logger.warn(
          `Failed to create lesson for user ${toLogId(activeUser.external_id)}: ${(err as Error).message} — sending notification video only`,
        );
      }

      span.setAttribute('notifier.media.count', media.length);
      return media;
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

export async function processNotifierSendJob(
  job: Job<NotifierSendJobData>,
  wabotOutbound: WabotOutboundService,
): Promise<void> {
  return tracer.startActiveSpan('notifier.send', async (span) => {
    const { user_external_id, media } = job.data;
    span.setAttribute('bullmq.job.id', String(job.id));
    span.setAttribute(
      'notifier.user.external_id_hash',
      toLogId(user_external_id),
    );
    span.setAttribute('notifier.media.count', media.length);
    try {
      const result = await wabotOutbound.sendNotification({
        user_external_id,
        media,
      });
      if (result.error_code !== undefined) {
        span.setAttribute('wabot.error_code', result.error_code);
      }
      span.setAttribute('notifier.delivered', result.delivered === true);

      if (result.error_code === 130429) {
        throw new Error(
          `WhatsApp rate-limit (130429) for user ${toLogId(user_external_id)} — will retry`,
        );
      }

      if (result.error_code === 131047) {
        span.setAttribute('notifier.skip_reason', 'window-expired');
        logger.warn(
          `Notification undeliverable: 24-hour window expired (131047) for user ${toLogId(user_external_id)}`,
        );
        return;
      }

      if (!result.delivered) {
        throw new Error(
          `Notification failed for user ${toLogId(user_external_id)}: status=${String(result.status)} error_code=${String(result.error_code)}`,
        );
      }

      logger.log(`Notification delivered to user ${toLogId(user_external_id)}`);
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
