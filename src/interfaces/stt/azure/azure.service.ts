import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { MediaMetaDataEntity } from '../../../media-meta-data/media-meta-data.entity';
import {
  MediaMetaData,
  assertValidMediaType,
  assertValidMediaSource,
  assertValidMediaStatus,
} from '../../../media-meta-data/media-meta-data.dto';

@Injectable()
export class AzureService {
  private readonly logger = new Logger(AzureService.name);

  constructor(
    @InjectRepository(MediaMetaDataEntity)
    private readonly mediaRepo: Repository<MediaMetaDataEntity>,
  ) {}

  async run(
    audioBuffer: Buffer,
    parentMedia: MediaMetaData,
  ): Promise<MediaMetaData> {
    if (audioBuffer.length === 0) {
      this.logger.warn(
        `Azure: empty audio buffer for ${parentMedia.id}`,
      );
      throw new Error('Empty audio buffer');
    }

    // 2. POST to Azure Fast Transcription
    const sttTimeCap = parseInt(process.env.STT_TIME_CAP ?? '5') * 1000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), sttTimeCap);

    const formData = new FormData();
    formData.append(
      'audio',
      new Blob([Uint8Array.from(audioBuffer)], {
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
        `${endpoint}/speechtotext/transcriptions:transcribe?api-version=2024-11-15`,
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

    const HINDI_DIGITS = ['शून्य', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'छह', 'सात', 'आठ', 'नौ'];
    const rawTranscript = result.combinedPhrases?.[0]?.text ?? '';
    const transcript = rawTranscript.replace(
      /\d+/g,
      (match) => match.split('').map((d) => HINDI_DIGITS[+d]).join(' '),
    );

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
    const entity = this.mediaRepo.create({
      id: uuid(),
      media_type: 'text',
      source: 'azure',
      status: 'ready',
      text: transcript,
      input_media_id: parentMedia.id,
      user_id: parentMedia.user_id,
      rolled_back: false,
      media_details: {
        duration_ms: result.durationMilliseconds,
        locale: result.phrases[0]?.locale ?? null,
        confidence: avgConfidence,
      },
    });

    return await this.mediaRepo.save(entity);
  }
}
