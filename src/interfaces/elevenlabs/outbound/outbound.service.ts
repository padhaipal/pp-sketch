import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Readable } from 'stream';
import { DataSource } from 'typeorm';
import { MediaBucketService } from '../../media-bucket/outbound/outbound.service';
import { createQueue, QUEUE_NAMES } from '../../redis/queues';
import { TtsRequest, TtsVoiceSettings } from './outbound.dto';
import { WhatsappPreloadJobDto } from '../../../media-meta-data/media-meta-data.dto';
import type { OtelCarrier } from '../../../otel/otel.dto';
import { startChildSpan, injectCarrier } from '../../../otel/otel';

const logger = new Logger('ElevenlabsOutboundService');
const whatsappPreloadQueue = createQueue(QUEUE_NAMES.WHATSAPP_PRELOAD);

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID!;

export interface ElevenlabsGenerateJobData {
  media_metadata_id: string;
  otel_carrier: OtelCarrier;
  elevenlabs_params: {
    script_text: string;
    voice_id?: string;
    model_id?: string;
    language_code?: string;
    voice_settings?: TtsVoiceSettings;
  };
}

export async function processElevenlabsGenerateJob(
  job: Job<ElevenlabsGenerateJobData>,
  mediaBucket: MediaBucketService,
  dataSource: DataSource,
): Promise<void> {
  const span = startChildSpan(
    'elevenlabs-generate-processor',
    job.data.otel_carrier,
  );

  try {
    const { media_metadata_id, elevenlabs_params } = job.data;

    const voiceId = elevenlabs_params.voice_id ?? ELEVENLABS_VOICE_ID;

    const requestBody: TtsRequest = {
      text: elevenlabs_params.script_text,
    };
    if (elevenlabs_params.model_id) {
      requestBody.model_id = elevenlabs_params.model_id;
    }
    if (elevenlabs_params.language_code) {
      requestBody.language_code = elevenlabs_params.language_code;
    }
    if (elevenlabs_params.voice_settings) {
      requestBody.voice_settings = elevenlabs_params.voice_settings;
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      },
    );

    if (response.ok) {
      // Response body is raw audio binary
      const stream = Readable.fromWeb(response.body! as any);
      const s3Key = await mediaBucket.stream(stream, 'audio/mpeg');

      const byteSize = response.headers.get('content-length');

      await dataSource.query(
        `UPDATE media_metadata
         SET s3_key = $1, media_details = $2, status = 'queued'
         WHERE id = $3`,
        [
          s3Key,
          JSON.stringify({
            mime_type: 'audio/mpeg',
            byte_size: byteSize ? parseInt(byteSize) : null,
          }),
          media_metadata_id,
        ],
      );

      await whatsappPreloadQueue.add(`preload-${media_metadata_id}`, {
        media_metadata_id,
        s3_key: s3Key,
        otel_carrier: injectCarrier(span),
      } as WhatsappPreloadJobDto);

      span.end();
    } else if (response.status >= 400 && response.status < 500) {
      const errorBody = await response.json();
      logger.error(
        `ElevenLabs TTS ${response.status}: ${JSON.stringify(errorBody)}`,
      );
      await dataSource.query(
        `UPDATE media_metadata SET status = 'failed', media_details = $1 WHERE id = $2`,
        [JSON.stringify({ error: errorBody }), media_metadata_id],
      );
      span.end();
      throw new Error(`ElevenLabs TTS ${response.status}`);
    } else {
      const errorBody = await response.text();
      const isLastAttempt =
        job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isLastAttempt) {
        logger.error(
          `ElevenLabs TTS 5XX (final attempt): ${errorBody}`,
        );
        await dataSource.query(
          `UPDATE media_metadata SET status = 'failed', media_details = $1 WHERE id = $2`,
          [JSON.stringify({ error: errorBody }), media_metadata_id],
        );
      } else {
        logger.warn(
          `ElevenLabs TTS 5XX (attempt ${job.attemptsMade + 1}): ${errorBody}`,
        );
      }
      span.end();
      throw new Error(`ElevenLabs TTS 5XX: ${response.status}`);
    }
  } catch (err) {
    span.end();
    throw err;
  }
}
