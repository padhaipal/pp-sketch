import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import { createQueue, QUEUE_NAMES } from '../interfaces/redis/queues';
import type { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';

const logger = new Logger('NotifierProcessor');

interface ActiveUser {
  user_id: string;
  external_id: string;
  last_message_at: Date;
}

export interface NotifierSendJobData {
  user_external_id: string;
  wa_media_url: string;
}

function getYesterdayIST7pm(): Date {
  const now = new Date();
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(now.getTime() + IST_OFFSET_MS);

  const yesterday7pmIST = new Date(
    Date.UTC(
      nowIST.getUTCFullYear(),
      nowIST.getUTCMonth(),
      nowIST.getUTCDate() - 1,
      19 - 5,
      0 - 30,
      0,
    ),
  );

  // Normalize: Date.UTC handles negative minutes by rolling back the hour/day.
  return yesterday7pmIST;
}

export async function processNotifierCronJob(
  _job: Job,
  dataSource: DataSource,
): Promise<void> {
  const cutoff = getYesterdayIST7pm();
  logger.log(`Notifier cron fired. Cutoff: ${cutoff.toISOString()}`);

  const activeUsers: ActiveUser[] = await dataSource.query(
    `SELECT mm.user_id, u.external_id, MAX(mm.created_at) AS last_message_at
     FROM media_metadata mm
     JOIN users u ON u.id = mm.user_id
     WHERE mm.source = 'whatsapp'
       AND mm.user_id IS NOT NULL
       AND mm.created_at >= $1
     GROUP BY mm.user_id, u.external_id`,
    [cutoff],
  );

  if (activeUsers.length === 0) {
    logger.log('No active users found since cutoff — skipping.');
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

  if (videoUrls.length === 0) {
    logger.error(
      'No evening_notification_message videos found with status=ready — aborting notification run.',
    );
    return;
  }

  const urls = videoUrls.map((r) => r.wa_media_url);

  // Sort by 24-hour expiry ascending (soonest-expiring first).
  // Expiry = last_message_at + 24h, so sorting by last_message_at ascending is equivalent.
  activeUsers.sort(
    (a, b) =>
      new Date(a.last_message_at).getTime() -
      new Date(b.last_message_at).getTime(),
  );

  const sendQueue = createQueue(QUEUE_NAMES.NOTIFIER_SEND);

  for (const user of activeUsers) {
    const randomUrl = urls[Math.floor(Math.random() * urls.length)];
    const jobData: NotifierSendJobData = {
      user_external_id: user.external_id,
      wa_media_url: randomUrl,
    };
    await sendQueue.add('send-notification', jobData);
  }

  logger.log(
    `Enqueued ${String(activeUsers.length)} notification-send jobs from ${String(urls.length)} video(s).`,
  );
}

export async function processNotifierSendJob(
  job: Job<NotifierSendJobData>,
  wabotOutbound: WabotOutboundService,
): Promise<void> {
  const { user_external_id, wa_media_url } = job.data;

  const result = await wabotOutbound.sendNotification({
    user_external_id,
    media: [{ type: 'video', url: wa_media_url }],
  });

  if (result.error_code === 130429) {
    throw new Error(
      `WhatsApp rate-limit (130429) for user ${user_external_id} — will retry`,
    );
  }

  if (result.error_code === 131047) {
    logger.warn(
      `Notification undeliverable: 24-hour window expired (131047) for user ${user_external_id}`,
    );
    return;
  }

  if (!result.delivered) {
    throw new Error(
      `Notification failed for user ${user_external_id}: status=${String(result.status)} error_code=${String(result.error_code)}`,
    );
  }

  logger.log(`Notification delivered to user ${user_external_id}`);
}
