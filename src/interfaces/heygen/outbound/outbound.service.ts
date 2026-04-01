import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Readable } from 'stream';
import { DataSource } from 'typeorm';
import { MediaBucketService } from '../../media-bucket/outbound/outbound.service';
import { createQueue, QUEUE_NAMES } from '../../redis/queues';
import {
  VideoGenerateRequest,
  VideoGenerateResponse,
  TtsRequest,
  TtsResponse,
} from './outbound.dto';
import { WhatsappPreloadJobDto, MediaMetaData } from '../../../media-meta-data/media-meta-data.dto';
import type { OtelCarrier } from '../../../otel/otel.dto';
import { startChildSpan, injectCarrier } from '../../../otel/otel';

const logger = new Logger('HeygenOutboundService');
const whatsappPreloadQueue = createQueue(QUEUE_NAMES.WHATSAPP_PRELOAD);

const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY!;
const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID!;
const HEYGEN_VOICE_ID = process.env.HEYGEN_VOICE_ID!;
const HEYGEN_CALLBACK_URL = process.env.HEYGEN_CALLBACK_URL!;

export interface HeygenGenerateJobData {
  media_metadata_id: string;
  media_type: 'video' | 'audio';
  otel_carrier: OtelCarrier;
  heygen_params: {
    script_text: string;
    avatar_id?: string;
    avatar_style?: string;
    voice_id?: string;
    speed?: number;
    emotion?: string;
    locale?: string;
    language?: string;
    title?: string;
    dimension?: { width: number; height: number };
    background?: any;
  };
}

export async function processHeygenGenerateJob(
  job: Job<HeygenGenerateJobData>,
  mediaBucket: MediaBucketService,
  dataSource: DataSource,
): Promise<void> {
  const span = startChildSpan(
    'heygen-generate-processor',
    job.data.otel_carrier,
  );

  try {
    const { media_metadata_id, media_type, heygen_params } = job.data;

    if (media_type === 'video') {
      // Build VideoGenerateRequest
      const requestBody: VideoGenerateRequest = {
        video_inputs: [
          {
            character: {
              type: 'avatar',
              avatar_id: heygen_params.avatar_id ?? HEYGEN_AVATAR_ID,
              avatar_style:
                (heygen_params.avatar_style as any) ?? 'normal',
            },
            voice: {
              type: 'text',
              voice_id: heygen_params.voice_id ?? HEYGEN_VOICE_ID,
              input_text: heygen_params.script_text,
              speed: heygen_params.speed,
              emotion: heygen_params.emotion as any,
              locale: heygen_params.locale,
            },
            background: heygen_params.background,
          },
        ],
        callback_id: media_metadata_id,
        callback_url: HEYGEN_CALLBACK_URL,
        title: heygen_params.title,
        dimension: heygen_params.dimension ?? {
          width: 1920,
          height: 1080,
        },
      };

      const response = await fetch(
        'https://api.heygen.com/v2/video/generate',
        {
          method: 'POST',
          headers: {
            'X-Api-Key': HEYGEN_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
      );

      if (response.ok) {
        const body =
          (await response.json()) as VideoGenerateResponse;
        await dataSource.query(
          `UPDATE media_metadata
           SET media_details = $1, status = 'queued'
           WHERE id = $2`,
          [
            JSON.stringify({ video_id: body.data.video_id }),
            media_metadata_id,
          ],
        );
        span.end();
      } else if (response.status >= 400 && response.status < 500) {
        const errorBody = await response.json();
        logger.error(
          `HeyGen video 4XX: ${JSON.stringify(errorBody)}`,
        );
        await dataSource.query(
          `UPDATE media_metadata SET status = 'failed', media_details = $1 WHERE id = $2`,
          [JSON.stringify({ error: errorBody }), media_metadata_id],
        );
        span.end();
        throw new Error(`HeyGen 4XX: ${response.status}`);
      } else {
        const errorBody = await response.text();
        const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (isLastAttempt) {
          logger.error(`HeyGen video 5XX (final attempt): ${errorBody}`);
          await dataSource.query(
            `UPDATE media_metadata SET status = 'failed', media_details = $1 WHERE id = $2`,
            [JSON.stringify({ error: errorBody }), media_metadata_id],
          );
        } else {
          logger.warn(`HeyGen video 5XX (attempt ${job.attemptsMade + 1}): ${errorBody}`);
        }
        span.end();
        throw new Error(`HeyGen 5XX: ${response.status}`);
      }
    } else if (media_type === 'audio') {
      // Build TtsRequest
      const requestBody: TtsRequest = {
        text: heygen_params.script_text,
        voice_id: heygen_params.voice_id ?? HEYGEN_VOICE_ID,
        speed: heygen_params.speed
          ? String(heygen_params.speed)
          : undefined,
        language: heygen_params.language,
        locale: heygen_params.locale,
      };

      const response = await fetch(
        'https://api.heygen.com/v1/audio/text_to_speech',
        {
          method: 'POST',
          headers: {
            'X-Api-Key': HEYGEN_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
      );

      if (response.ok) {
        const body = (await response.json()) as TtsResponse;
        const { audio_url, duration, request_id, word_timestamps } =
          body.data;

        // Download audio from HeyGen
        const audioResponse = await fetch(audio_url);
        if (!audioResponse.ok) {
          throw new Error(
            `Failed to download TTS audio: ${audioResponse.status}`,
          );
        }

        const stream = Readable.fromWeb(audioResponse.body! as any);
        const s3Key = await mediaBucket.stream(
          stream,
          'audio/mpeg',
        );

        // Get byte_size from Content-Length if available
        const byteSize = audioResponse.headers.get('content-length');

        await dataSource.query(
          `UPDATE media_metadata
           SET s3_key = $1, media_details = $2, status = 'queued'
           WHERE id = $3`,
          [
            s3Key,
            JSON.stringify({
              mime_type: 'audio/mpeg',
              duration,
              byte_size: byteSize ? parseInt(byteSize) : null,
              request_id,
              word_timestamps,
            }),
            media_metadata_id,
          ],
        );

        // Enqueue WHATSAPP_PRELOAD
        await whatsappPreloadQueue.add(
          `preload-${media_metadata_id}`,
          {
            media_metadata_id,
            s3_key: s3Key,
            otel_carrier: injectCarrier(span),
          } as WhatsappPreloadJobDto,
        );

        span.end();
      } else if (response.status >= 400 && response.status < 500) {
        const errorBody = await response.json();
        logger.error(
          `HeyGen TTS 4XX: ${JSON.stringify(errorBody)}`,
        );
        await dataSource.query(
          `UPDATE media_metadata SET status = 'failed', media_details = $1 WHERE id = $2`,
          [JSON.stringify({ error: errorBody }), media_metadata_id],
        );
        span.end();
        throw new Error(`HeyGen TTS 4XX: ${response.status}`);
      } else {
        const errorBody = await response.text();
        const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (isLastAttempt) {
          logger.error(`HeyGen TTS 5XX (final attempt): ${errorBody}`);
          await dataSource.query(
            `UPDATE media_metadata SET status = 'failed', media_details = $1 WHERE id = $2`,
            [JSON.stringify({ error: errorBody }), media_metadata_id],
          );
        } else {
          logger.warn(`HeyGen TTS 5XX (attempt ${job.attemptsMade + 1}): ${errorBody}`);
        }
        span.end();
        throw new Error(`HeyGen TTS 5XX: ${response.status}`);
      }
    }
  } catch (err) {
    span.end();
    throw err;
  }
}
