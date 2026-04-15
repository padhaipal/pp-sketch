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
export class SarvamService {
  private readonly logger = new Logger(SarvamService.name);

  constructor(
    @InjectRepository(MediaMetaDataEntity)
    private readonly mediaRepo: Repository<MediaMetaDataEntity>,
  ) {}

  async run(
    audioBuffer: Buffer,
    parentMedia: MediaMetaData,
  ): Promise<MediaMetaData> {
    const t0 = Date.now();

    if (audioBuffer.length === 0) {
      this.logger.warn(
        `Sarvam: empty audio buffer for ${parentMedia.id}`,
      );
      throw new Error('Empty audio buffer');
    }

    // 2. POST to Sarvam
    const sttTimeCap = parseInt(process.env.STT_TIME_CAP ?? '5') * 1000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), sttTimeCap);

    const formData = new FormData();
    formData.append(
      'file',
      new Blob([Uint8Array.from(audioBuffer)], {
        type:
          (parentMedia.media_details?.mime_type as string) ?? 'audio/ogg',
      }),
      `${parentMedia.id}.ogg`,
    );
    formData.append('model', 'saaras:v3');
    formData.append('mode', 'verbatim');
    formData.append('language_code', 'hi-IN');

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

    const tResponse = Date.now();

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
    const entity = this.mediaRepo.create({
      id: uuid(),
      media_type: 'text',
      source: 'sarvam',
      status: 'ready',
      text: result.transcript,
      input_media_id: parentMedia.id,
      user_id: parentMedia.user_id,
      rolled_back: false,
      media_details: {
        language_code: result.language_code,
        language_probability: result.language_probability,
        sarvam_request_id: result.request_id,
      },
    });

    const saved = await this.mediaRepo.save(entity);

    return saved;
  }
}
