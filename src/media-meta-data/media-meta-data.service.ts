import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Readable, PassThrough } from 'stream';
import { v4 as uuid } from 'uuid';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { CacheService } from '../interfaces/redis/cache';
import { CACHE_KEYS, CACHE_TTL } from '../interfaces/redis/cache.dto';
import { UserService } from '../users/user.service';
import { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';
import { MediaBucketService } from '../interfaces/media-bucket/outbound/outbound.service';
import { SarvamService } from '../interfaces/stt/sarvam/sarvam.service';
import { AzureService } from '../interfaces/stt/azure/azure.service';
import { ReverieService } from '../interfaces/stt/reverie/reverie.service';
import { createQueue, QUEUE_NAMES } from '../interfaces/redis/queues';
import type { OtelCarrier } from '../otel/otel.dto';
import {
  MediaMetaData,
  MediaType,
  CreateWhatsappAudioMediaOptions,
  CreateTextMediaOptions,
  CreateHeygenMediaOptions,
  CreateElevenlabsMediaOptions,
  validateCreateElevenlabsMediaOptions,
  FindTranscriptsOptions,
  FindMediaByStateTransitionIdResult,
  UploadStaticMediaItem,
  UploadStaticMediaResult,
  UploadStaticMediaItemResult,
  WhatsappPreloadJobDto,
  validateCreateWhatsappAudioMediaOptions,
  validateCreateTextMediaOptions,
  validateCreateHeygenMediaOptions,
  validateFindTranscriptsOptions,
  assertValidMediaType,
  assertValidMediaSource,
  assertValidMediaStatus,
} from './media-meta-data.dto';

// Feature flag check (OpenFeature)
const STT_DEFAULTS: Record<string, boolean> = {
  sarvam: true,
  azure: false,
  reverie: false,
};
async function isSttEnabled(provider: string): Promise<boolean> {
  const fallback = STT_DEFAULTS[provider] ?? false;
  try {
    const { OpenFeature } = await import('@openfeature/server-sdk');
    const client = OpenFeature.getClient();
    return await client.getBooleanValue(`stt.${provider}.enabled`, fallback);
  } catch {
    return fallback;
  }
}

@Injectable()
export class MediaMetaDataService {
  private readonly logger = new Logger(MediaMetaDataService.name);
  private readonly heygenGenerateQueue = createQueue(
    QUEUE_NAMES.HEYGEN_GENERATE,
  );
  private readonly elevenlabsGenerateQueue = createQueue(
    QUEUE_NAMES.ELEVENLABS_GENERATE,
  );
  private readonly whatsappPreloadQueue = createQueue(
    QUEUE_NAMES.WHATSAPP_PRELOAD,
  );

  constructor(
    private readonly dataSource: DataSource,
    private readonly cacheService: CacheService,
    private readonly userService: UserService,
    private readonly wabotOutbound: WabotOutboundService,
    private readonly mediaBucket: MediaBucketService,
    private readonly sarvamService: SarvamService,
    private readonly azureService: AzureService,
    private readonly reverieService: ReverieService,
  ) {}

  async createWhatsappAudioMedia(
    options: CreateWhatsappAudioMediaOptions,
  ): Promise<MediaMetaData> {
    const validated = validateCreateWhatsappAudioMediaOptions(options);

    // 2. Resolve user
    let userId: string;
    if (validated.user) {
      userId = validated.user.id;
    } else {
      const user = await this.userService.find({
        external_id: validated.user_external_id!,
      });
      if (!user) {
        this.logger.error(
          `createWhatsappAudioMedia: user not found for external_id ${validated.user_external_id}`,
        );
        throw new NotFoundException(
          `User not found for external_id ${validated.user_external_id}`,
        );
      }
      userId = user.id;
    }

    // 3. Check existing
    const existing = await this.dataSource.query(
      'SELECT * FROM media_metadata WHERE wa_media_url = $1',
      [validated.wa_media_url],
    );

    let entity: MediaMetaData;

    if (existing.length > 0) {
      if (existing[0].status === 'failed') {
        await this.dataSource.query(
          "UPDATE media_metadata SET status = 'created' WHERE id = $1",
          [existing[0].id],
        );
        entity = { ...existing[0], status: 'created' };
      } else {
        this.logger.warn(
          `createWhatsappAudioMedia: duplicate wa_media_url ${validated.wa_media_url} with status ${existing[0].status}`,
        );
        return existing[0];
      }
    } else {
      const id = uuid();
      const rows = await this.dataSource.query(
        `INSERT INTO media_metadata (id, wa_media_url, status, media_type, source, user_id, rolled_back)
         VALUES ($1, $2, 'created', 'audio', 'whatsapp', $3, false) RETURNING *`,
        [id, validated.wa_media_url, userId],
      );
      entity = rows[0];
    }

    // 4. Download and stream to S3 + STT providers in parallel
    const { stream: audioStream, content_type } =
      await this.wabotOutbound.downloadMedia(validated.wa_media_url, validated.otel_carrier);

    // Buffer the stream so we can fan it out
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const audioBuffer = Buffer.concat(chunks);

    // S3 upload
    let s3Key: string;
    try {
      s3Key = await this.mediaBucket.stream(
        Readable.from(audioBuffer),
        content_type,
      );
    } catch (err) {
      await this.dataSource.query(
        "UPDATE media_metadata SET status = 'failed' WHERE id = $1",
        [entity.id],
      );
      this.logger.warn(
        `createWhatsappAudioMedia: S3 upload failed for ${entity.id}`,
      );
      throw err;
    }

    // STT providers in parallel (feature flag gated)
    const sttPromises: Promise<MediaMetaData | null>[] = [];

    const [sarvamEnabled, azureEnabled, reverieEnabled] = await Promise.all(
      [
        isSttEnabled('sarvam'),
        isSttEnabled('azure'),
        isSttEnabled('reverie'),
      ],
    );

    if (sarvamEnabled) {
      sttPromises.push(
        this.sarvamService
          .run(Readable.from(audioBuffer), entity)
          .catch((err) => {
            this.logger.warn(
              `Sarvam STT failed for ${entity.id}: ${(err as Error).message}`,
            );
            return null;
          }),
      );
    }
    if (azureEnabled) {
      sttPromises.push(
        this.azureService
          .run(Readable.from(audioBuffer), entity)
          .catch((err) => {
            this.logger.warn(
              `Azure STT failed for ${entity.id}: ${(err as Error).message}`,
            );
            return null;
          }),
      );
    }
    if (reverieEnabled) {
      sttPromises.push(
        this.reverieService
          .run(Readable.from(audioBuffer), entity)
          .catch((err) => {
            this.logger.warn(
              `Reverie STT failed for ${entity.id}: ${(err as Error).message}`,
            );
            return null;
          }),
      );
    }

    const sttResults = await Promise.all(sttPromises);
    const successfulStt = sttResults.filter(
      (r): r is MediaMetaData => r !== null,
    );

    if (successfulStt.length === 0 && sttPromises.length > 0) {
      await this.dataSource.query(
        "UPDATE media_metadata SET status = 'failed' WHERE id = $1",
        [entity.id],
      );
      this.logger.warn(
        `createWhatsappAudioMedia: all STT providers failed for ${entity.id}`,
      );
      throw new Error('All STT providers failed');
    }

    // 5. Update the audio entity
    const updated = await this.dataSource.query(
      `UPDATE media_metadata
       SET s3_key = $1, media_details = $2, status = 'ready'
       WHERE id = $3 RETURNING *`,
      [
        s3Key,
        JSON.stringify({
          mime_type: content_type,
          byte_size: audioBuffer.length,
          ...validated.media_details,
        }),
        entity.id,
      ],
    );

    this.logger.log(
      `[HPTRACE-SHAPE] updated typeof=${typeof updated} isArray=${Array.isArray(updated)} length=${(updated as unknown as { length?: number })?.length} keys=${updated && typeof updated === 'object' ? Object.keys(updated as object).join(',') : 'N/A'} json=${JSON.stringify(updated)}`,
    );
    if (Array.isArray(updated) && updated.length > 0) {
      this.logger.log(
        `[HPTRACE-SHAPE] updated[0] typeof=${typeof updated[0]} isArray=${Array.isArray(updated[0])} keys=${updated[0] && typeof updated[0] === 'object' ? Object.keys(updated[0] as object).join(',') : 'N/A'}`,
      );
    }

    return updated[0];
  }

  async createTextMedia(
    options: CreateTextMediaOptions,
  ): Promise<MediaMetaData> {
    const validated = validateCreateTextMediaOptions(options);

    // Resolve user
    let userId: string;
    if (validated.user) {
      userId = validated.user.id;
    } else {
      const user = await this.userService.find({
        external_id: validated.user_external_id!,
      });
      if (!user) {
        this.logger.error(
          `createTextMedia: user not found for external_id ${validated.user_external_id}`,
        );
        throw new NotFoundException(
          `User not found for external_id ${validated.user_external_id}`,
        );
      }
      userId = user.id;
    }

    const source = validated.source ?? 'whatsapp';
    assertValidMediaType('text');
    assertValidMediaSource(source);
    assertValidMediaStatus('ready');

    const id = uuid();
    const rows = await this.dataSource.query(
      `INSERT INTO media_metadata (id, text, status, media_type, source, user_id, input_media_id, media_details, rolled_back)
       VALUES ($1, $2, 'ready', 'text', $3, $4, $5, $6, false) RETURNING *`,
      [
        id,
        validated.text,
        source,
        userId,
        validated.input_media_id ?? null,
        validated.media_details
          ? JSON.stringify(validated.media_details)
          : null,
      ],
    );

    return rows[0];
  }

  async findTranscripts(
    options: FindTranscriptsOptions,
  ): Promise<MediaMetaData[]> {
    const validated = validateFindTranscriptsOptions(options);

    let resolvedId: string;
    if (validated.media_metadata) {
      resolvedId = validated.media_metadata.id;
    } else if (validated.media_metadata_id) {
      resolvedId = validated.media_metadata_id;
    } else {
      const rows = await this.dataSource.query(
        'SELECT id FROM media_metadata WHERE wa_media_url = $1',
        [validated.media_metadata_wa_media_url],
      );
      if (rows.length === 0) return [];
      resolvedId = rows[0].id;
    }

    const rows = await this.dataSource.query(
      `SELECT * FROM media_metadata
       WHERE input_media_id = $1 AND media_type = 'text' AND status = 'ready'
       ORDER BY created_at ASC`,
      [resolvedId],
    );
    return rows;
  }

  async findMediaByStateTransitionId(
    stateTransitionId: string,
  ): Promise<FindMediaByStateTransitionIdResult> {
    if (
      typeof stateTransitionId !== 'string' ||
      stateTransitionId.length === 0
    ) {
      throw new BadRequestException(
        'stateTransitionId must be a non-empty string',
      );
    }

    const dashIdx = stateTransitionId.indexOf('-');
    const genericKey =
      dashIdx >= 0 ? `_${stateTransitionId.substring(dashIdx)}` : null;

    const cached =
      await this.cacheService.get<FindMediaByStateTransitionIdResult>(
        CACHE_KEYS.mediaByStateTransitionId(stateTransitionId),
      );
    if (cached) {
      this.logger.log(`[HPTRACE] findMediaBySTID: CACHE HIT stid="${stateTransitionId}" mediaTypes=[${Object.keys(cached).join(', ')}]`);
      return cached;
    }

    const keys = genericKey ? [stateTransitionId, genericKey] : [stateTransitionId];
    this.logger.log(`[HPTRACE] findMediaBySTID: stid="${stateTransitionId}" genericKey="${genericKey}" queryKeys=[${keys.join(', ')}]`);
    const rows = await this.dataSource.query(
      `SELECT * FROM media_metadata
       WHERE state_transition_id = ANY($1::text[])
         AND status = 'ready'
         AND (wa_media_url IS NOT NULL OR media_type = 'text')`,
      [keys],
    );
    this.logger.log(`[HPTRACE] findMediaBySTID: stid="${stateTransitionId}" dbRows=${rows.length}${rows.length > 0 ? ` types=[${rows.map((r: any) => `${r.media_type}:${r.state_transition_id}`).join(', ')}]` : ''}`);

    const specificByType = new Map<string, MediaMetaData[]>();
    const genericByType = new Map<string, MediaMetaData[]>();
    for (const row of rows) {
      const bucket =
        row.state_transition_id === stateTransitionId
          ? specificByType
          : genericByType;
      const existing = bucket.get(row.media_type) ?? [];
      existing.push(row);
      bucket.set(row.media_type, existing);
    }

    const result: FindMediaByStateTransitionIdResult = {};
    for (const type of ['audio', 'video', 'text', 'image'] as const) {
      const items = specificByType.get(type) ?? genericByType.get(type);
      if (items && items.length > 0) {
        result[type] = items[Math.floor(Math.random() * items.length)];
      }
    }

    const resultTypes = Object.keys(result);
    if (resultTypes.length === 0) {
      this.logger.warn(`[HPTRACE] findMediaBySTID: NO MEDIA FOUND for stid="${stateTransitionId}" (keys=[${keys.join(', ')}])`);
    } else {
      this.logger.log(`[HPTRACE] findMediaBySTID: stid="${stateTransitionId}" returning mediaTypes=[${resultTypes.join(', ')}]`);
    }

    if (resultTypes.length > 0) {
      await this.cacheService.set(
        CACHE_KEYS.mediaByStateTransitionId(stateTransitionId),
        result,
        CACHE_TTL.MEDIA_BY_STATE_TRANSITION,
      );
    }

    return result;
  }

  async markRolledBack(mediaId: string): Promise<void> {
    if (typeof mediaId !== 'string' || mediaId.length === 0) {
      throw new BadRequestException(
        'mediaId must be a non-empty string',
      );
    }

    // Fetch s3_key before DB transaction
    const rows = await this.dataSource.query(
      'SELECT s3_key FROM media_metadata WHERE id = $1',
      [mediaId],
    );
    const s3Key: string | null = rows.length > 0 ? rows[0].s3_key : null;

    await this.dataSource.query(
      `DO $$
      DECLARE
        rec RECORD;
      BEGIN
        UPDATE media_metadata SET rolled_back = true WHERE id = $1;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Media metadata not found';
        END IF;

        FOR rec IN
          SELECT con.conrelid::regclass AS referencing_table,
                 att.attname            AS referencing_column
          FROM pg_constraint con
          JOIN pg_attribute att
            ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
          WHERE con.confrelid = 'media_metadata'::regclass
            AND con.contype = 'f'
            AND EXISTS (
              SELECT 1 FROM pg_attribute pa
              WHERE pa.attrelid = con.confrelid
                AND pa.attnum = ANY(con.confkey)
                AND pa.attname = 'id'
            )
        LOOP
          EXECUTE format('DELETE FROM %I WHERE %I = $1', rec.referencing_table, rec.referencing_column) USING $1;
        END LOOP;
      END
      $$ LANGUAGE plpgsql`,
      [mediaId],
    );

    // Delete S3 object after DB commit (best-effort)
    if (s3Key) {
      try {
        await this.mediaBucket.delete(s3Key);
      } catch (err) {
        this.logger.warn(
          `S3 cleanup failed for rolled-back media ${mediaId} (key: ${s3Key}): ${(err as Error).message}`,
        );
      }
    }
  }

  async createHeygenMedia(
    options: CreateHeygenMediaOptions,
    otel_carrier: OtelCarrier,
  ): Promise<MediaMetaData[]> {
    const validated = validateCreateHeygenMediaOptions(options);

    const entities: MediaMetaData[] = [];
    const jobPayloads: any[] = [];

    for (const item of validated.items) {
      assertValidMediaType(item.media_type);
      assertValidMediaSource('heygen');

      const id = uuid();
      const rows = await this.dataSource.query(
        `INSERT INTO media_metadata (id, state_transition_id, wa_media_url, status, media_type, source, user_id, rolled_back, generation_request_json)
         VALUES ($1, $2, NULL, 'created', $3, 'heygen', NULL, false, $4) RETURNING *`,
        [
          id,
          item.state_transition_id,
          item.media_type,
          JSON.stringify({
            script_text: item.script_text,
            state_transition_id: item.state_transition_id,
            media_type: item.media_type,
            ...(item.avatar_id && item.avatar_id !== process.env.HEYGEN_AVATAR_ID && { avatar_id: item.avatar_id }),
            ...(item.avatar_style && { avatar_style: item.avatar_style }),
            ...(item.voice_id && item.voice_id !== process.env.HEYGEN_VOICE_ID && { voice_id: item.voice_id }),
            ...(item.speed !== undefined && { speed: item.speed }),
            ...(item.emotion && { emotion: item.emotion }),
            ...(item.locale && { locale: item.locale }),
            ...(item.language && { language: item.language }),
            ...(item.title && { title: item.title }),
            ...(item.dimension && { dimension: item.dimension }),
            ...(item.background && { background: item.background }),
          }),
        ],
      );
      entities.push(rows[0]);

      jobPayloads.push({
        name: `heygen-generate-${id}`,
        data: {
          media_metadata_id: id,
          media_type: item.media_type,
          otel_carrier,
          heygen_params: {
            script_text: item.script_text,
            avatar_id: item.avatar_id,
            avatar_style: item.avatar_style,
            voice_id: item.voice_id,
            speed: item.speed,
            emotion: item.emotion,
            locale: item.locale,
            language: item.language,
            title: item.title,
            dimension: item.dimension,
            background: item.background,
          },
        },
      });
    }

    // Enqueue with retry
    let enqueued = false;
    let delay = 1000;
    const startTime = Date.now();
    while (!enqueued) {
      try {
        await this.heygenGenerateQueue.addBulk(jobPayloads);
        enqueued = true;
      } catch (err) {
        if (Date.now() - startTime > 10_000) {
          const ids = entities.map((e) => e.id);
          const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
          await this.dataSource.query(
            `UPDATE media_metadata SET status = 'failed' WHERE id IN (${placeholders})`,
            ids,
          );
          this.logger.error(
            `createHeygenMedia: failed to enqueue after 10s`,
          );
          throw err;
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    }

    // Mark as queued
    const ids = entities.map((e) => e.id);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    await this.dataSource.query(
      `UPDATE media_metadata SET status = 'queued' WHERE id IN (${placeholders})`,
      ids,
    );

    return entities.map((e) => ({ ...e, status: 'queued' as const }));
  }

  async createElevenlabsMedia(
    options: CreateElevenlabsMediaOptions,
    otel_carrier: OtelCarrier,
  ): Promise<MediaMetaData[]> {
    const validated = validateCreateElevenlabsMediaOptions(options);

    const entities: MediaMetaData[] = [];
    const jobPayloads: any[] = [];

    for (const item of validated.items) {
      assertValidMediaType('audio');
      assertValidMediaSource('elevenlabs');

      const id = uuid();
      const rows = await this.dataSource.query(
        `INSERT INTO media_metadata (id, state_transition_id, wa_media_url, status, media_type, source, user_id, rolled_back, generation_request_json)
         VALUES ($1, $2, NULL, 'created', 'audio', 'elevenlabs', NULL, false, $3) RETURNING *`,
        [
          id,
          item.state_transition_id,
          JSON.stringify({
            script_text: item.script_text,
            state_transition_id: item.state_transition_id,
            ...(item.voice_id && item.voice_id !== process.env.ELEVENLABS_VOICE_ID && { voice_id: item.voice_id }),
            ...(item.model_id && { model_id: item.model_id }),
            ...(item.language_code && { language_code: item.language_code }),
            ...(item.voice_settings && { voice_settings: item.voice_settings }),
          }),
        ],
      );
      entities.push(rows[0]);

      jobPayloads.push({
        name: `elevenlabs-generate-${id}`,
        data: {
          media_metadata_id: id,
          otel_carrier,
          elevenlabs_params: {
            script_text: item.script_text,
            voice_id: item.voice_id,
            model_id: item.model_id,
            language_code: item.language_code,
            voice_settings: item.voice_settings,
          },
        },
      });
    }

    // Enqueue with retry
    let enqueued = false;
    let delay = 1000;
    const startTime = Date.now();
    while (!enqueued) {
      try {
        await this.elevenlabsGenerateQueue.addBulk(jobPayloads);
        enqueued = true;
      } catch (err) {
        if (Date.now() - startTime > 10_000) {
          const ids = entities.map((e) => e.id);
          const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
          await this.dataSource.query(
            `UPDATE media_metadata SET status = 'failed' WHERE id IN (${placeholders})`,
            ids,
          );
          this.logger.error(
            `createElevenlabsMedia: failed to enqueue after 10s`,
          );
          throw err;
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    }

    // Mark as queued
    const ids = entities.map((e) => e.id);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    await this.dataSource.query(
      `UPDATE media_metadata SET status = 'queued' WHERE id IN (${placeholders})`,
      ids,
    );

    return entities.map((e) => ({ ...e, status: 'queued' as const }));
  }

  async uploadStaticMedia(
    files: Express.Multer.File[],
    items: UploadStaticMediaItem[],
    otel_carrier: OtelCarrier,
  ): Promise<UploadStaticMediaResult> {
    const results: UploadStaticMediaItemResult[] = [];
    let fileCursor = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // --- Text item branch ---
      if (item.media_type === 'text') {
        try {
          assertValidMediaType('text');
          assertValidMediaSource('dashboard');

          const dupRows = await this.dataSource.query(
            `SELECT * FROM media_metadata
             WHERE state_transition_id = $1
               AND media_type = 'text'
               AND text = $2
             LIMIT 1`,
            [item.state_transition_id, item.text],
          );

          if (dupRows.length > 0 && dupRows[0].status === 'ready') {
            results.push({
              index: i,
              status: 'duplicate_skipped',
              entity: dupRows[0],
            });
            continue;
          }

          let entity: MediaMetaData;
          if (dupRows.length > 0 && dupRows[0].status === 'failed') {
            const rows = await this.dataSource.query(
              `UPDATE media_metadata
               SET status = 'ready', rolled_back = false
               WHERE id = $1 RETURNING *`,
              [dupRows[0].id],
            );
            entity = rows[0];
          } else {
            const id = uuid();
            const rows = await this.dataSource.query(
              `INSERT INTO media_metadata (id, state_transition_id, media_type, source, status, text, s3_key, content_hash, wa_media_url, user_id, rolled_back, media_details)
               VALUES ($1, $2, 'text', 'dashboard', 'ready', $3, NULL, NULL, NULL, NULL, false, NULL) RETURNING *`,
              [id, item.state_transition_id, item.text],
            );
            entity = rows[0];
          }

          results.push({ index: i, status: 'created', entity });
        } catch (err) {
          this.logger.warn(
            `uploadStaticMedia[${i}]: text insert failed: ${(err as Error).message}`,
          );
          results.push({
            index: i,
            status: 'failed',
            error: (err as Error).message,
          });
        }
        continue;
      }

      // --- Non-text item branch ---
      const file = files[fileCursor];
      fileCursor++;

      try {
        // 1. Compute hash
        const content_hash = crypto
          .createHash('sha256')
          .update(file.buffer)
          .digest('hex');

        // 2. Infer media type from file (already validated by assertValidStaticMediaFile)
        const mimeToType: Record<string, MediaType> = {
          'image/jpeg': 'image',
          'image/png': 'image',
          'image/webp': 'image',
          'video/mp4': 'video',
          'audio/ogg': 'audio',
        };
        const media_type = mimeToType[file.mimetype];
        assertValidMediaType(media_type);
        assertValidMediaSource('dashboard');

        if (media_type !== item.media_type) {
          throw new BadRequestException(
            `uploadStaticMedia() items[${i}].media_type "${item.media_type}" does not match file MIME-inferred type "${media_type}"`,
          );
        }

        // 3. Dedup check
        const dupRows = await this.dataSource.query(
          `SELECT * FROM media_metadata
           WHERE content_hash = $1 AND state_transition_id = $2
           LIMIT 1`,
          [content_hash, item.state_transition_id],
        );

        if (dupRows.length > 0) {
          const dup = dupRows[0];
          if (
            dup.status === 'created' ||
            dup.status === 'queued' ||
            dup.status === 'ready'
          ) {
            results.push({
              index: i,
              status: 'duplicate_skipped',
              entity: dup,
            });
            continue;
          }
          // status === 'failed' — reuse row, continue to upload
        }

        // 4. Upload to S3
        let s3Key: string;
        try {
          s3Key = await this.mediaBucket.stream(
            Readable.from(file.buffer),
            file.mimetype,
          );
        } catch (err) {
          this.logger.warn(
            `uploadStaticMedia[${i}]: S3 upload failed: ${(err as Error).message}`,
          );
          results.push({
            index: i,
            status: 'failed',
            error: (err as Error).message,
          });
          continue;
        }

        // 5. Create or update media_metadata row
        let entity: MediaMetaData;
        try {
          if (dupRows.length > 0 && dupRows[0].status === 'failed') {
            const rows = await this.dataSource.query(
              `UPDATE media_metadata
               SET s3_key = $1, status = 'created', media_details = $2, rolled_back = false
               WHERE id = $3 RETURNING *`,
              [
                s3Key,
                JSON.stringify({
                  mime_type: file.mimetype,
                  byte_size: file.size,
                }),
                dupRows[0].id,
              ],
            );
            entity = rows[0];
          } else {
            const id = uuid();
            const rows = await this.dataSource.query(
              `INSERT INTO media_metadata (id, state_transition_id, s3_key, content_hash, wa_media_url, media_type, source, status, user_id, rolled_back, media_details)
               VALUES ($1, $2, $3, $4, NULL, $5, 'dashboard', 'created', NULL, false, $6) RETURNING *`,
              [
                id,
                item.state_transition_id,
                s3Key,
                content_hash,
                media_type,
                JSON.stringify({
                  mime_type: file.mimetype,
                  byte_size: file.size,
                }),
              ],
            );
            entity = rows[0];
          }
        } catch (err) {
          this.logger.warn(
            `uploadStaticMedia[${i}]: PG write failed: ${(err as Error).message}`,
          );
          results.push({
            index: i,
            status: 'failed',
            error: (err as Error).message,
          });
          continue;
        }

        // 6. Enqueue WHATSAPP_PRELOAD
        try {
          await this.whatsappPreloadQueue.add(
            `preload-${entity.id}`,
            {
              media_metadata_id: entity.id,
              s3_key: s3Key,
              reload: false,
              otel_carrier,
            } as WhatsappPreloadJobDto,
          );
        } catch (err) {
          this.logger.warn(
            `uploadStaticMedia[${i}]: enqueue failed: ${(err as Error).message}`,
          );
          await this.dataSource.query(
            "UPDATE media_metadata SET status = 'failed' WHERE id = $1",
            [entity.id],
          );
          results.push({
            index: i,
            status: 'failed',
            error: (err as Error).message,
          });
          continue;
        }

        // 7. Mark as queued
        await this.dataSource.query(
          "UPDATE media_metadata SET status = 'queued' WHERE id = $1",
          [entity.id],
        );

        results.push({
          index: i,
          status: 'created',
          entity: { ...entity, status: 'queued' },
        });
      } catch (err) {
        results.push({
          index: i,
          status: 'failed',
          error: (err as Error).message,
        });
      }
    }

    const summary = {
      created: results.filter((r) => r.status === 'created').length,
      duplicate_skipped: results.filter(
        (r) => r.status === 'duplicate_skipped',
      ).length,
      failed: results.filter((r) => r.status === 'failed').length,
    };

    return { results, summary };
  }
}
