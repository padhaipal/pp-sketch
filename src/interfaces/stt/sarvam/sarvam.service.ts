import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { pool } from '../../database/database';
import {
  MediaMetaData,
  assertValidMediaType,
  assertValidMediaSource,
  assertValidMediaStatus,
} from '../../../media-meta-data/media-meta-data.dto';

@Injectable()
export class SarvamService {
  private readonly logger = new Logger(SarvamService.name);

  async run(
    audioStream: NodeJS.ReadableStream,
    parentMedia: MediaMetaData,
  ): Promise<MediaMetaData> {
    // 1. Buffer stream
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const audioBuffer = Buffer.concat(chunks);
    if (audioBuffer.length === 0) {
      this.logger.warn(
        `Sarvam: empty audio stream for ${parentMedia.id}`,
      );
      throw new Error('Empty audio stream');
    }

    // 2. POST to Sarvam
    const sttTimeCap = parseInt(process.env.STT_TIME_CAP ?? '30') * 1000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), sttTimeCap);

    const formData = new FormData();
    formData.append(
      'file',
      new Blob([audioBuffer], {
        type:
          (parentMedia.media_details?.mime_type as string) ?? 'audio/ogg',
      }),
      `${parentMedia.id}.ogg`,
    );
    formData.append('model', 'saaras:v3');
    formData.append('mode', 'transcribe');
    formData.append('language_code', 'unknown');

    let response: Response;
    try {
      response = await fetch(
        'https://api.sarvam.ai/speech-to-text',
        {
          method: 'POST',
          headers: {
            'api-subscription-key': process.env.SARVAM_API_KEY!,
          },
          body: formData,
          signal: controller.signal,
        },
      );
    } catch (err) {
      clearTimeout(timeout);
      this.logger.warn(
        `Sarvam: network/timeout error for ${parentMedia.id}: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    // 3. Handle response
    if (response.status >= 400 && response.status < 500) {
      const body = await response.text();
      this.logger.warn(
        `Sarvam 4XX for ${parentMedia.id}: ${response.status} ${body}`,
      );
      throw new Error(`Sarvam STT failed: ${response.status}`);
    }
    if (!response.ok) {
      const body = await response.text();
      this.logger.warn(
        `Sarvam 5XX for ${parentMedia.id}: ${response.status} ${body}`,
      );
      throw new Error(`Sarvam STT failed: ${response.status}`);
    }

    const result = (await response.json()) as {
      request_id: string;
      transcript: string;
      language_code: string | null;
      language_probability: number | null;
    };

    // 4. Assert enums
    assertValidMediaType('text');
    assertValidMediaSource('sarvam');
    assertValidMediaStatus('ready');

    // 5. Create media_metadata row
    const id = uuid();
    const { rows } = await pool.query<MediaMetaData>(
      `INSERT INTO media_metadata (id, media_type, source, status, text, input_media_id, user_id, rolled_back, media_details)
       VALUES ($1, 'text', 'sarvam', 'ready', $2, $3, $4, false, $5) RETURNING *`,
      [
        id,
        result.transcript,
        parentMedia.id,
        parentMedia.user_id,
        JSON.stringify({
          language_code: result.language_code,
          language_probability: result.language_probability,
          sarvam_request_id: result.request_id,
        }),
      ],
    );

    return rows[0];
  }
}
