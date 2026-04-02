import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { CacheService } from '../interfaces/redis/cache';
import { CACHE_KEYS } from '../interfaces/redis/cache.dto';
import { MediaBucketService } from '../interfaces/media-bucket/outbound/outbound.service';
import { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';
import { createQueue, QUEUE_NAMES } from '../interfaces/redis/queues';
import { WhatsappPreloadJobDto, MediaMetaData } from './media-meta-data.dto';
import { startChildSpan, injectCarrier } from '../otel/otel';

const logger = new Logger('WhatsappPreloadProcessor');
const whatsappPreloadQueue = createQueue(QUEUE_NAMES.WHATSAPP_PRELOAD);

export async function processWhatsappPreloadJob(
  job: Job<WhatsappPreloadJobDto>,
  mediaBucket: MediaBucketService,
  wabotOutbound: WabotOutboundService,
  cacheService: CacheService,
  dataSource: DataSource,
): Promise<void> {
  const span = startChildSpan(
    'whatsapp-preload-processor',
    job.data.otel_carrier,
  );

  try {
    const { media_metadata_id, s3_key, reload } = job.data;

    // 2. Look up entity
    const rows = await dataSource.query(
      'SELECT * FROM media_metadata WHERE id = $1',
      [media_metadata_id],
    );

    if (rows.length === 0) {
      logger.warn(`Entity ${media_metadata_id} not found — skipping`);
      span.end();
      return;
    }

    const entity = rows[0];
    if (entity.rolled_back) {
      logger.warn(`Entity ${media_metadata_id} rolled back — skipping`);
      span.end();
      return;
    }
    if (entity.status === 'failed') {
      logger.warn(
        `Entity ${media_metadata_id} has failed status — skipping`,
      );
      span.end();
      return;
    }

    // 3. Fetch from S3
    let buffer: Buffer;
    let content_type: string;
    try {
      const result = await mediaBucket.getBuffer(s3_key);
      buffer = result.buffer;
      content_type = result.content_type;
    } catch (err) {
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isLastAttempt) {
        logger.error(
          `S3 getBuffer failed for ${s3_key} (final attempt): ${(err as Error).message}`,
        );
      } else {
        logger.warn(
          `S3 getBuffer failed for ${s3_key} (attempt ${job.attemptsMade + 1}): ${(err as Error).message}`,
        );
      }
      span.end();
      throw err;
    }

    // 4. Determine WhatsApp media type
    const media_type = entity.media_type;

    // 5. Upload to WhatsApp
    let wa_media_url: string;
    logger.log(
      `calling wabotOutbound.uploadMedia for ${media_metadata_id}, content_type=${content_type}, media_type=${media_type}, buffer_size=${buffer.length}`,
    );
    try {
      const result = await wabotOutbound.uploadMedia(
        buffer,
        content_type,
        media_type,
        injectCarrier(span),
      );
      wa_media_url = result.wa_media_url;
      logger.log(
        `uploadMedia succeeded for ${media_metadata_id}, wa_media_url=${wa_media_url}`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      logger.error(
        `uploadMedia threw for ${media_metadata_id}: ${msg}`,
      );
      const statusMatch = msg.match(/(\d{3})/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 0;
      if (status >= 400 && status < 500) {
        logger.error(`uploadMedia 4XX for ${media_metadata_id}`);
        await dataSource.query(
          "UPDATE media_metadata SET status = 'failed' WHERE id = $1",
          [media_metadata_id],
        );
      } else {
        logger.warn(`uploadMedia 5XX for ${media_metadata_id}`);
      }
      span.end();
      throw err;
    }

    // 6. Update entity
    if (reload) {
      await dataSource.query(
        'UPDATE media_metadata SET wa_media_url = $1 WHERE id = $2',
        [wa_media_url, media_metadata_id],
      );
    } else {
      await dataSource.query(
        "UPDATE media_metadata SET wa_media_url = $1, status = 'ready' WHERE id = $2",
        [wa_media_url, media_metadata_id],
      );
    }

    // 7. Invalidate cache
    if (entity.state_transition_id) {
      await cacheService.del(
        CACHE_KEYS.mediaByStateTransitionId(
          entity.state_transition_id,
        ),
      );
    }

    // 8. Enqueue reload job (20 days)
    const TWENTY_DAYS_MS = 20 * 24 * 60 * 60 * 1000;
    let reloadEnqueued = false;
    let delay = 1000;
    const startTime = Date.now();
    while (!reloadEnqueued) {
      try {
        await whatsappPreloadQueue.add(
          `reload-${media_metadata_id}`,
          {
            media_metadata_id,
            s3_key,
            reload: true,
            otel_carrier: injectCarrier(span),
          },
          { delay: TWENTY_DAYS_MS },
        );
        reloadEnqueued = true;
      } catch (err) {
        if (Date.now() - startTime > 10_000) {
          logger.error(
            `Failed to enqueue reload for ${media_metadata_id} — media will expire`,
          );
          break;
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    }

    span.end();
  } catch (err) {
    span.end();
    throw err;
  }
}
