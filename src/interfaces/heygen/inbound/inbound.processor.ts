import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Readable } from 'stream';
import { pool } from '../../database/database';
import { MediaBucketService } from '../../media-bucket/outbound/outbound.service';
import { createQueue, QUEUE_NAMES } from '../../redis/queues';
import { WhatsappPreloadJobDto, MediaMetaData } from '../../../media-meta-data/media-meta-data.dto';
import { HeygenInboundJobDto } from './inbound.dto';
import { startChildSpan, injectCarrier } from '../../../otel/otel';

const logger = new Logger('HeygenInboundProcessor');
const whatsappPreloadQueue = createQueue(QUEUE_NAMES.WHATSAPP_PRELOAD);

export async function processHeygenInboundJob(
  job: Job<HeygenInboundJobDto>,
  mediaBucket: MediaBucketService,
): Promise<void> {
  const span = startChildSpan(
    'heygen-inbound-processor',
    job.data.otel_carrier,
  );

  try {
    const { event_type, event_data } = job.data;

    if (event_type === 'avatar_video.success') {
      // a. Validate
      const video_id = event_data.video_id as string;
      const url = event_data.url as string;
      const callback_id = event_data.callback_id as string;

      if (!callback_id || callback_id.length === 0) {
        logger.error('avatar_video.success: missing callback_id');
        span.end();
        throw new Error('Missing callback_id');
      }

      // b. Look up entity
      const { rows } = await pool.query<MediaMetaData>(
        'SELECT * FROM media_metadata WHERE id = $1',
        [callback_id],
      );
      if (rows.length === 0) {
        logger.error(
          `avatar_video.success: entity ${callback_id} not found`,
        );
        span.end();
        throw new Error('Entity not found');
      }

      // c. Download video
      const response = await fetch(url);
      if (!response.ok) {
        logger.error(
          `avatar_video.success: failed to download video from ${url}`,
        );
        await pool.query(
          "UPDATE media_metadata SET status = 'failed' WHERE id = $1",
          [callback_id],
        );
        span.end();
        throw new Error('Video download failed');
      }

      // d. Stream to S3
      let s3Key: string;
      try {
        const stream = Readable.fromWeb(response.body! as any);
        s3Key = await mediaBucket.stream(stream, 'video/mp4');
      } catch (err) {
        logger.error(
          `avatar_video.success: S3 upload failed for ${callback_id}`,
        );
        await pool.query(
          "UPDATE media_metadata SET status = 'failed' WHERE id = $1",
          [callback_id],
        );
        span.end();
        throw err;
      }

      // e. Update entity
      await pool.query(
        `UPDATE media_metadata
         SET s3_key = $1, media_details = $2, status = 'queued'
         WHERE id = $3`,
        [
          s3Key,
          JSON.stringify({
            video_url: url,
            mime_type: 'video/mp4',
          }),
          callback_id,
        ],
      );

      // f. Enqueue WHATSAPP_PRELOAD
      await whatsappPreloadQueue.add(`preload-${callback_id}`, {
        media_metadata_id: callback_id,
        s3_key: s3Key,
        otel_carrier: injectCarrier(span),
      } as WhatsappPreloadJobDto);

      // g. Done
      span.end();
    } else if (event_type === 'avatar_video.fail') {
      // a. Validate
      const video_id = event_data.video_id as string;
      const msg = event_data.msg as string;
      const callback_id = event_data.callback_id as string;

      if (!callback_id || callback_id.length === 0) {
        logger.error('avatar_video.fail: missing callback_id');
        span.end();
        throw new Error('Missing callback_id');
      }

      // b. Look up entity
      const { rows } = await pool.query<MediaMetaData>(
        'SELECT * FROM media_metadata WHERE id = $1',
        [callback_id],
      );
      if (rows.length === 0) {
        logger.error(
          `avatar_video.fail: entity ${callback_id} not found`,
        );
        span.end();
        throw new Error('Entity not found');
      }

      // c. Update entity
      await pool.query(
        `UPDATE media_metadata SET status = 'failed', media_details = $1 WHERE id = $2`,
        [JSON.stringify({ error_msg: msg }), callback_id],
      );

      // d. Log
      logger.error(
        `HeyGen video generation failed: video_id=${video_id}, msg=${msg}`,
      );

      // e. Done (no retry)
      span.end();
    }
  } catch (err) {
    span.end();
    throw err;
  }
}
