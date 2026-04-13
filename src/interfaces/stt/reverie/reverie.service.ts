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
export class ReverieService {
  private readonly logger = new Logger(ReverieService.name);

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
        `Reverie: empty audio buffer for ${parentMedia.id}`,
      );
      throw new Error('Empty audio buffer');
    }

    // 2. POST to Reverie
    const sttTimeCap = parseInt(process.env.STT_TIME_CAP ?? '5') * 1000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), sttTimeCap);

    const formData = new FormData();
    formData.append(
      'audio_file',
      new Blob([Uint8Array.from(audioBuffer)]),
      `${parentMedia.id}.ogg`,
    );

    let response: Response;
    try {
      response = await fetch('https://revapi.reverieinc.com/', {
        method: 'POST',
        headers: {
          'REV-API-KEY': process.env.REVERIE_API_KEY!,
          'REV-APP-ID': process.env.REVERIE_APP_ID!,
          'REV-APPNAME': 'stt_file',
          src_lang: 'hi',
          domain: 'generic',
          format: 'ogg_opus',
          logging: 'false',
          punctuate: 'true',
        },
        body: formData,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      this.logger.warn(
        `Reverie: network/timeout error for ${parentMedia.id}: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    // 3. Handle response
    if (!response.ok) {
      const body = await response.text();
      this.logger.warn(
        `Reverie ${response.status} for ${parentMedia.id}: ${body}`,
      );
      throw new Error(`Reverie STT failed: ${response.status}`);
    }

    const result = (await response.json()) as {
      id: string;
      success: boolean;
      final: boolean;
      text: string;
      display_text: string;
      confidence: number;
      cause: string;
    };

    if (!result.success) {
      this.logger.warn(
        `Reverie STT unsuccessful for ${parentMedia.id}: ${result.cause}`,
      );
      throw new Error(`Reverie STT unsuccessful: ${result.cause}`);
    }

    // 4. Assert enums
    assertValidMediaType('text');
    assertValidMediaSource('reverie');
    assertValidMediaStatus('ready');

    // 5. Create media_metadata row
    const entity = this.mediaRepo.create({
      id: uuid(),
      media_type: 'text',
      source: 'reverie',
      status: 'ready',
      text: result.display_text,
      input_media_id: parentMedia.id,
      user_id: parentMedia.user_id,
      rolled_back: false,
      media_details: {
        raw_text: result.text,
        confidence: result.confidence,
        reverie_request_id: result.id,
        cause: result.cause,
      },
    });

    return await this.mediaRepo.save(entity);
  }
}
