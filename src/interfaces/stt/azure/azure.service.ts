import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { DataSource } from 'typeorm';
import {
  MediaMetaData,
  assertValidMediaType,
  assertValidMediaSource,
  assertValidMediaStatus,
} from '../../../media-meta-data/media-meta-data.dto';

@Injectable()
export class AzureService {
  private readonly logger = new Logger(AzureService.name);

  constructor(private readonly dataSource: DataSource) {}

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
        `Azure: empty audio stream for ${parentMedia.id}`,
      );
      throw new Error('Empty audio stream');
    }

    // 2. POST to Azure Fast Transcription
    const sttTimeCap = parseInt(process.env.STT_TIME_CAP ?? '5') * 1000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), sttTimeCap);

    const formData = new FormData();
    formData.append(
      'audio',
      new Blob([audioBuffer], {
        type:
          (parentMedia.media_details?.mime_type as string) ?? 'audio/ogg',
      }),
      `${parentMedia.id}.ogg`,
    );
    formData.append(
      'definition',
      JSON.stringify({ locales: ['hi-IN'] }),
    );

    const endpoint = process.env.AZURE_SPEECH_ENDPOINT!;

    let response: Response;
    try {
      response = await fetch(
        `${endpoint}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY!,
          },
          body: formData,
          signal: controller.signal,
        },
      );
    } catch (err) {
      clearTimeout(timeout);
      this.logger.warn(
        `Azure: network/timeout error for ${parentMedia.id}: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    // 3. Handle response
    if (response.status !== 200) {
      const errorBody = await response.json().catch(() => ({})) as any;
      this.logger.warn(
        `Azure ${response.status} for ${parentMedia.id}: ${errorBody?.error?.code} ${errorBody?.error?.message}`,
      );
      throw new Error(`Azure STT failed: ${response.status}`);
    }

    const result = (await response.json()) as {
      durationMilliseconds: number;
      combinedPhrases: Array<{ text: string }>;
      phrases: Array<{
        text: string;
        locale: string;
        confidence: number;
      }>;
    };

    const transcript =
      result.combinedPhrases?.[0]?.text ?? '';

    const avgConfidence =
      result.phrases.length > 0
        ? result.phrases.reduce((s, p) => s + p.confidence, 0) /
          result.phrases.length
        : null;

    // 4. Assert enums
    assertValidMediaType('text');
    assertValidMediaSource('azure');
    assertValidMediaStatus('ready');

    // 5. Create media_metadata row
    const id = uuid();
    const rows = await this.dataSource.query(
      `INSERT INTO media_metadata (id, media_type, source, status, text, input_media_id, user_id, rolled_back, media_details)
       VALUES ($1, 'text', 'azure', 'ready', $2, $3, $4, false, $5) RETURNING *`,
      [
        id,
        transcript,
        parentMedia.id,
        parentMedia.user_id,
        JSON.stringify({
          duration_ms: result.durationMilliseconds,
          locale: result.phrases[0]?.locale ?? null,
          confidence: avgConfidence,
        }),
      ],
    );

    return rows[0];
  }
}
