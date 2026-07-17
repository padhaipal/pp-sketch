import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Readable } from 'stream';
import { v4 as uuid } from 'uuid';
import * as crypto from 'crypto';
import { trace } from '@opentelemetry/api';
import { drillWordMediaCreateFailure } from '../otel/metrics';
import { MediaMetaDataEntity } from './media-meta-data.entity';
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
  CreateRenderedImageMediaOptions,
  validateCreateRenderedImageMediaOptions,
  validateCreateWhatsappAudioMediaOptions,
  validateCreateTextMediaOptions,
  validateCreateHeygenMediaOptions,
  validateFindTranscriptsOptions,
  assertValidMediaType,
  assertValidMediaSource,
  assertValidMediaStatus,
  type MediaStatus,
} from './media-meta-data.dto';

// Feature flag check (OpenFeature)
const STT_DEFAULTS: Record<string, boolean> = {
  sarvam: true,
  azure: true,
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

// Sentence→word drill hand-off stids ({word}-sentence-word-drillWord). The
// drilled word can be any Hindi word (not just word-list entries), so its
// text prompt cannot be pre-seeded — on lookup miss the row is auto-created
// (source='drill-word-auto') and then served like any other text media. The
// prefix guard excludes the generic key ('_') and the fixed 'sentence-*'
// prompt stids, whose media is human-seeded.
const DRILL_WORD_STID_RE = /^([^-]+)-sentence-word-drillWord$/;
const DRILL_WORD_EXCLUDED_PREFIXES = new Set(['_', 'sentence']);
// Backoff for the auto-create write: attempts at ~0/1/2/4/8s (±25% jitter),
// bounded by a 20s wall-clock budget — by then wabot's timeout fallback has
// already reached the user, so later attempts would only benefit the NEXT
// turn (and the row is created then anyway).
const DRILL_WORD_CREATE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const DRILL_WORD_CREATE_DEADLINE_MS = 20_000;

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
    @InjectRepository(MediaMetaDataEntity)
    private readonly mediaRepo: Repository<MediaMetaDataEntity>,
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
    let userExternalId: string;
    if (validated.user) {
      userId = validated.user.id;
      userExternalId = validated.user.external_id;
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
      userExternalId = validated.user_external_id!;
    }

    // 3. Check existing
    const existing = await this.mediaRepo.findOneBy({
      wa_media_url: validated.wa_media_url,
    });

    let entity: MediaMetaDataEntity;

    if (existing) {
      if (existing.status === 'failed') {
        existing.status = 'created';
        await this.mediaRepo.save(existing);
        entity = existing;
      } else {
        this.logger.warn(
          `createWhatsappAudioMedia: duplicate wa_media_url ${validated.wa_media_url} with status ${existing.status}`,
        );
        return existing;
      }
    } else {
      entity = this.mediaRepo.create({
        id: uuid(),
        wa_media_url: validated.wa_media_url,
        status: 'created',
        media_type: 'audio',
        source: 'whatsapp',
        user_id: userId,
        rolled_back: false,
      });
      entity = await this.mediaRepo.save(entity);
    }

    // 4. Download and stream to S3 + STT providers in parallel
    const { stream: audioStream, content_type } =
      await this.wabotOutbound.downloadMedia(
        validated.wa_media_url,
        validated.otel_carrier,
        userExternalId,
      );

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
      entity.status = 'failed';
      await this.mediaRepo.save(entity);
      this.logger.warn(
        `createWhatsappAudioMedia: S3 upload failed for ${entity.id}`,
      );
      throw err;
    }

    // STT providers in parallel (feature flag gated)
    const sttPromises: Promise<MediaMetaData | null>[] = [];

    const [sarvamEnabled, azureEnabled, reverieEnabled] = await Promise.all([
      isSttEnabled('sarvam'),
      isSttEnabled('azure'),
      isSttEnabled('reverie'),
    ]);

    if (sarvamEnabled) {
      sttPromises.push(
        this.sarvamService
          .run(audioBuffer, entity, userExternalId)
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
          .run(audioBuffer, entity, userExternalId)
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
          .run(audioBuffer, entity, userExternalId)
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
      entity.status = 'failed';
      await this.mediaRepo.save(entity);
      this.logger.warn(
        `createWhatsappAudioMedia: all STT providers failed for ${entity.id}`,
      );
      throw new Error('All STT providers failed');
    }

    // 5. Update the audio entity
    entity.s3_key = s3Key;
    entity.media_details = {
      mime_type: content_type,
      byte_size: audioBuffer.length,
      ...validated.media_details,
    };
    entity.status = 'ready';
    const saved = await this.mediaRepo.save(entity);

    return saved;
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

    const entity = this.mediaRepo.create({
      id: uuid(),
      text: validated.text,
      status: 'ready',
      media_type: 'text',
      source,
      user_id: userId,
      input_media_id: validated.input_media_id ?? null,
      media_details: validated.media_details ?? null,
      rolled_back: false,
    });

    return await this.mediaRepo.save(entity);
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
      const row = await this.mediaRepo.findOneBy({
        wa_media_url: validated.media_metadata_wa_media_url!,
      });
      if (!row) return [];
      resolvedId = row.id;
    }

    return await this.mediaRepo.find({
      where: {
        input_media_id: resolvedId,
        media_type: 'text',
        status: 'ready',
      },
      order: { created_at: 'ASC' },
    });
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
      return cached;
    }

    // Raw SQL — uses ANY($1::text[]) for multi-key lookup
    const keys = genericKey
      ? [stateTransitionId, genericKey]
      : [stateTransitionId];
    const rows: MediaMetaData[] = await this.dataSource.query(
      `SELECT * FROM media_metadata
       WHERE state_transition_id = ANY($1::text[])
         AND status = 'ready'
         AND rolled_back = false
         AND (wa_media_url IS NOT NULL OR media_type = 'text')`,
      [keys],
    );
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
    for (const type of [
      'audio',
      'video',
      'text',
      'image',
      'sticker',
    ] as const) {
      const items = specificByType.get(type) ?? genericByType.get(type);
      if (items && items.length > 0) {
        result[type] = items[Math.floor(Math.random() * items.length)];
      }
    }

    // Drill hand-off with no text media (exact or generic): auto-create the
    // word's text row so the turn always carries the drilled word and can
    // never produce an empty outbound bundle.
    if (!result.text) {
      const drillMatch = DRILL_WORD_STID_RE.exec(stateTransitionId);
      if (drillMatch && !DRILL_WORD_EXCLUDED_PREFIXES.has(drillMatch[1])) {
        result.text = await this.ensureDrillWordTextMedia(
          stateTransitionId,
          drillMatch[1],
        );
      }
    }

    const resultTypes = Object.keys(result);
    if (resultTypes.length === 0) {
      this.logger.warn(
        `findMediaBySTID: no media found for stid="${stateTransitionId}"`,
      );
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

  // Returns the drill word's auto-created text row, creating it if absent.
  // Race-safe across instances: the partial unique index on
  // (state_transition_id) WHERE source='drill-word-auto' makes the INSERT's
  // ON CONFLICT DO NOTHING lose quietly, and the follow-up SELECT returns the
  // winner's row. Retries transient DB failures with jittered exponential
  // backoff inside a 20s budget, then throws (the turn fails; wabot's timeout
  // fallback reaches the user).
  private async ensureDrillWordTextMedia(
    stateTransitionId: string,
    word: string,
  ): Promise<MediaMetaData> {
    const startedAt = Date.now();
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const inserted: MediaMetaData[] = await this.dataSource.query(
          `INSERT INTO media_metadata (id, media_type, source, status, text, state_transition_id, rolled_back)
           VALUES ($1, 'text', 'drill-word-auto', 'ready', $2, $3, false)
           ON CONFLICT (state_transition_id) WHERE source = 'drill-word-auto' DO NOTHING
           RETURNING *`,
          [uuid(), word, stateTransitionId],
        );
        let row = inserted[0];
        if (!row) {
          // Lost the race — another instance created it; read the winner.
          const existing: MediaMetaData[] = await this.dataSource.query(
            `SELECT * FROM media_metadata
             WHERE state_transition_id = $1 AND source = 'drill-word-auto'
             LIMIT 1`,
            [stateTransitionId],
          );
          row = existing[0];
        }
        if (!row) {
          throw new Error(
            'drill-word auto-create: conflict but no existing row found',
          );
        }
        if (attempt > 1) {
          this.logger.warn(
            `drill-word auto-create succeeded after ${attempt} attempts for stid="${stateTransitionId}" — possible DB pressure`,
          );
        } else {
          this.logger.log(
            `drill-word auto-create: created text media for stid="${stateTransitionId}"`,
          );
        }
        return row;
      } catch (err) {
        const baseDelay =
          DRILL_WORD_CREATE_RETRY_DELAYS_MS[
            Math.min(attempt - 1, DRILL_WORD_CREATE_RETRY_DELAYS_MS.length - 1)
          ];
        const delay = baseDelay * (0.75 + Math.random() * 0.5); // ±25% jitter
        const outOfBudget =
          Date.now() - startedAt + delay > DRILL_WORD_CREATE_DEADLINE_MS ||
          attempt > DRILL_WORD_CREATE_RETRY_DELAYS_MS.length;
        drillWordMediaCreateFailure.add(1, {
          final: String(outOfBudget),
        });
        trace.getActiveSpan()?.addEvent('drill_word_media_create_failed', {
          'pp.media.stid': stateTransitionId,
          'pp.media.attempt': attempt,
          'pp.media.final': outOfBudget,
        });
        if (outOfBudget) {
          this.logger.error(
            `drill-word auto-create FAILED after ${attempt} attempts (${Date.now() - startedAt}ms) for stid="${stateTransitionId}": ${(err as Error).message}`,
          );
          throw err;
        }
        this.logger.warn(
          `drill-word auto-create attempt ${attempt} failed for stid="${stateTransitionId}", retrying in ${Math.round(delay)}ms: ${(err as Error).message}`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async markRolledBack(mediaId: string): Promise<void> {
    if (typeof mediaId !== 'string' || mediaId.length === 0) {
      throw new BadRequestException('mediaId must be a non-empty string');
    }

    // Fetch s3_key + state_transition_id before DB transaction
    const entity = await this.mediaRepo.findOneBy({ id: mediaId });
    const s3Key: string | null = entity?.s3_key ?? null;
    const stid: string | null = entity?.state_transition_id ?? null;

    await this.dataSource.transaction(async (manager) => {
      // TypeORM's pg manager.query returns [rowsArray, affectedCount] for
      // UPDATE/INSERT/DELETE — affectedCount is the second element.
      const [, affected]: [unknown[], number] = await manager.query(
        `UPDATE media_metadata SET rolled_back = true WHERE id = $1`,
        [mediaId],
      );
      if (affected === 0) {
        throw new NotFoundException('Media metadata not found');
      }

      // Audit log: outbound_messages is deliberately EXCLUDED from the
      // generic FK sweep below (its rows are never deleted — user data).
      // Instead the rollback is recorded on them, atomically with the media
      // flag. Convention deviation (cross-entity write inside this
      // transaction) mirrors user.service.ts's hard-delete: atomicity wins
      // over module boundaries.
      await manager.query(
        `UPDATE outbound_messages SET status = 'rolled_back' WHERE user_message_id = $1`,
        [mediaId],
      );

      // Identifier escaping done by PG via format() — %s for regclass keeps
      // search-path-correct schema qualification; %I quotes the column name.
      const fkStmts: { sql: string }[] = await manager.query(
        `SELECT format('DELETE FROM %s WHERE %I = $1', con.conrelid::regclass, att.attname) AS sql
         FROM pg_constraint con
         JOIN pg_attribute att
           ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
         WHERE con.confrelid = 'media_metadata'::regclass
           AND con.contype = 'f'
           AND con.conrelid <> 'outbound_messages'::regclass
           AND EXISTS (
             SELECT 1 FROM pg_attribute pa
             WHERE pa.attrelid = con.confrelid
               AND pa.attnum = ANY(con.confkey)
               AND pa.attname = 'id'
           )`,
      );

      for (const { sql } of fkStmts) {
        await manager.query(sql, [mediaId]);
      }
    });

    // Invalidate STID cache so readers don't keep serving the rolled-back row.
    if (stid) {
      await this.cacheService.del(CACHE_KEYS.mediaByStateTransitionId(stid));
    }

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

    const entities: MediaMetaDataEntity[] = [];
    const jobPayloads: any[] = [];

    for (const item of validated.items) {
      assertValidMediaType(item.media_type);
      assertValidMediaSource('heygen');

      const entity = this.mediaRepo.create({
        id: uuid(),
        state_transition_id: item.state_transition_id,
        wa_media_url: null,
        status: 'created',
        media_type: item.media_type,
        source: 'heygen',
        user_id: null,
        rolled_back: false,
        generation_request_json: {
          script_text: item.script_text,
          state_transition_id: item.state_transition_id,
          media_type: item.media_type,
          ...(item.avatar_id &&
            item.avatar_id !== process.env.HEYGEN_AVATAR_ID && {
              avatar_id: item.avatar_id,
            }),
          ...(item.avatar_style && { avatar_style: item.avatar_style }),
          ...(item.voice_id &&
            item.voice_id !== process.env.HEYGEN_VOICE_ID && {
              voice_id: item.voice_id,
            }),
          ...(item.speed !== undefined && { speed: item.speed }),
          ...(item.emotion && { emotion: item.emotion }),
          ...(item.locale && { locale: item.locale }),
          ...(item.language && { language: item.language }),
          ...(item.title && { title: item.title }),
          ...(item.dimension && { dimension: item.dimension }),
          ...(item.background && { background: item.background }),
        },
      });
      const saved = await this.mediaRepo.save(entity);
      entities.push(saved);

      jobPayloads.push({
        name: `heygen-generate-${saved.id}`,
        data: {
          media_metadata_id: saved.id,
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
          await this.mediaRepo.update(ids, { status: 'failed' });
          this.logger.error(`createHeygenMedia: failed to enqueue after 10s`);
          throw err;
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    }

    // Mark as queued
    const ids = entities.map((e) => e.id);
    await this.mediaRepo.update(ids, { status: 'queued' });

    return entities.map((e) => ({ ...e, status: 'queued' as const }));
  }

  async createElevenlabsMedia(
    options: CreateElevenlabsMediaOptions,
    otel_carrier: OtelCarrier,
  ): Promise<MediaMetaData[]> {
    const validated = validateCreateElevenlabsMediaOptions(options);

    const entities: MediaMetaDataEntity[] = [];
    const jobPayloads: any[] = [];

    for (const item of validated.items) {
      assertValidMediaType('audio');
      assertValidMediaSource('elevenlabs');

      const entity = this.mediaRepo.create({
        id: uuid(),
        state_transition_id: item.state_transition_id,
        wa_media_url: null,
        status: 'created',
        media_type: 'audio',
        source: 'elevenlabs',
        user_id: null,
        rolled_back: false,
        generation_request_json: {
          script_text: item.script_text,
          state_transition_id: item.state_transition_id,
          ...(item.voice_id &&
            item.voice_id !== process.env.ELEVENLABS_VOICE_ID && {
              voice_id: item.voice_id,
            }),
          ...(item.model_id && { model_id: item.model_id }),
          ...(item.language_code && { language_code: item.language_code }),
          ...(item.voice_settings && { voice_settings: item.voice_settings }),
        },
      });
      const saved = await this.mediaRepo.save(entity);
      entities.push(saved);

      jobPayloads.push({
        name: `elevenlabs-generate-${saved.id}`,
        data: {
          media_metadata_id: saved.id,
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
          await this.mediaRepo.update(ids, { status: 'failed' });
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
    await this.mediaRepo.update(ids, { status: 'queued' });

    return entities.map((e) => ({ ...e, status: 'queued' as const }));
  }

  // Persists a rendered image (e.g. report card) as a media_metadata row,
  // streams the bytes to S3, and enqueues a whatsapp-preload job. Returns the
  // entity in 'queued' state. The preload worker drives it to 'ready' once the
  // WhatsApp upload completes.
  async createRenderedImageMedia(
    options: CreateRenderedImageMediaOptions,
  ): Promise<MediaMetaData> {
    const validated = validateCreateRenderedImageMediaOptions(options);

    const content_hash = crypto
      .createHash('sha256')
      .update(validated.buffer)
      .digest('hex');

    let entity: MediaMetaDataEntity = this.mediaRepo.create({
      id: uuid(),
      state_transition_id: validated.state_transition_id ?? null,
      media_type: 'image',
      source: validated.source,
      status: 'created',
      content_hash,
      wa_media_url: null,
      user_id: validated.user_id,
      rolled_back: false,
      media_details: {
        mime_type: validated.mime_type,
        byte_size: validated.buffer.length,
        ...validated.media_details,
      },
    });
    entity = await this.mediaRepo.save(entity);

    let s3Key: string;
    try {
      s3Key = await this.mediaBucket.stream(
        Readable.from(validated.buffer),
        validated.mime_type,
      );
    } catch (err) {
      entity.status = 'failed';
      await this.mediaRepo.save(entity);
      throw err;
    }
    entity.s3_key = s3Key;
    entity = await this.mediaRepo.save(entity);

    try {
      await this.whatsappPreloadQueue.add(`preload-${entity.id}`, {
        media_metadata_id: entity.id,
        s3_key: s3Key,
        reload: false,
        otel_carrier: validated.otel_carrier,
      } as WhatsappPreloadJobDto);
    } catch (err) {
      // Enqueue failure is transient (Redis blip), not a defect in the
      // media — the file is already in S3. Leave it 'queued' so the
      // media-reload-sweep rescues it within ~6h; 'failed' is reserved
      // for permanent rejection.
      entity.status = 'queued';
      await this.mediaRepo.save(entity);
      throw err;
    }

    entity.status = 'queued';
    return await this.mediaRepo.save(entity);
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

          const dupRow = await this.mediaRepo.findOne({
            where: {
              state_transition_id: item.state_transition_id,
              media_type: 'text',
              text: item.text,
            },
          });

          if (dupRow && dupRow.status === 'ready') {
            results.push({
              index: i,
              status: 'duplicate_skipped',
              entity: dupRow,
            });
            continue;
          }

          let entity: MediaMetaDataEntity;
          if (dupRow && dupRow.status === 'failed') {
            dupRow.status = 'ready';
            dupRow.rolled_back = false;
            entity = await this.mediaRepo.save(dupRow);
          } else {
            entity = this.mediaRepo.create({
              id: uuid(),
              state_transition_id: item.state_transition_id,
              media_type: 'text',
              source: 'dashboard',
              status: 'ready',
              text: item.text,
              s3_key: null,
              content_hash: null,
              wa_media_url: null,
              user_id: null,
              rolled_back: false,
              media_details: null,
            });
            entity = await this.mediaRepo.save(entity);
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

        // 2. Infer media type from file
        const mimeToType: Record<string, MediaType> = {
          'image/jpeg': 'image',
          'image/png': 'image',
          'image/webp': 'sticker',
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
        const dupRow = await this.mediaRepo.findOne({
          where: {
            content_hash,
            state_transition_id: item.state_transition_id,
          },
        });

        if (dupRow) {
          if (
            dupRow.status === 'created' ||
            dupRow.status === 'queued' ||
            dupRow.status === 'ready'
          ) {
            results.push({
              index: i,
              status: 'duplicate_skipped',
              entity: dupRow,
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
        let entity: MediaMetaDataEntity;
        try {
          if (dupRow && dupRow.status === 'failed') {
            dupRow.s3_key = s3Key;
            dupRow.status = 'created';
            dupRow.media_details = {
              mime_type: file.mimetype,
              byte_size: file.size,
            };
            dupRow.rolled_back = false;
            entity = await this.mediaRepo.save(dupRow);
          } else {
            entity = this.mediaRepo.create({
              id: uuid(),
              state_transition_id: item.state_transition_id,
              s3_key: s3Key,
              content_hash,
              wa_media_url: null,
              media_type,
              source: 'dashboard',
              status: 'created',
              user_id: null,
              rolled_back: false,
              media_details: {
                mime_type: file.mimetype,
                byte_size: file.size,
              },
            });
            entity = await this.mediaRepo.save(entity);
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
          await this.whatsappPreloadQueue.add(`preload-${entity.id}`, {
            media_metadata_id: entity.id,
            s3_key: s3Key,
            reload: false,
            otel_carrier,
          } as WhatsappPreloadJobDto);
        } catch (err) {
          this.logger.warn(
            `uploadStaticMedia[${i}]: enqueue failed: ${(err as Error).message}`,
          );
          // Transient enqueue failure, file already in S3 — stay 'queued'
          // so the media-reload-sweep rescues it within ~6h.
          entity.status = 'queued';
          await this.mediaRepo.save(entity);
          results.push({
            index: i,
            status: 'failed',
            error: (err as Error).message,
          });
          continue;
        }

        // 7. Mark as queued
        entity.status = 'queued';
        await this.mediaRepo.save(entity);

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
      duplicate_skipped: results.filter((r) => r.status === 'duplicate_skipped')
        .length,
      failed: results.filter((r) => r.status === 'failed').length,
    };

    return { results, summary };
  }

  // Records a WhatsApp-confirmed upload. wa_uploaded_at is written in the
  // same UPDATE as wa_media_url so the stamp can never disagree with the
  // url — the media-reload-sweep relies on it to decide what is overdue.
  // markReady=false on reloads: those only refresh the url.
  async recordWhatsappUpload(
    id: string,
    wa_media_url: string,
    markReady: boolean,
  ): Promise<void> {
    await this.mediaRepo.update(id, {
      wa_media_url,
      wa_uploaded_at: new Date(),
      ...(markReady ? { status: 'ready' as MediaStatus } : {}),
    });
  }

  // Permanent rejection (e.g. WhatsApp 4XX on upload). 'failed' rows are
  // never retried by the media-reload-sweep.
  async markMediaFailed(id: string): Promise<void> {
    await this.mediaRepo.update(id, { status: 'failed' });
  }
}
