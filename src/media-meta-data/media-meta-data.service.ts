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
import { OpenaiLlmService } from '../interfaces/llm/openai/openai-llm.service';
import { AnthropicLlmService } from '../interfaces/llm/anthropic/anthropic-llm.service';
import { GoogleLlmService } from '../interfaces/llm/google/google-llm.service';
import { MistralLlmService } from '../interfaces/llm/mistral/mistral-llm.service';
import { SarvamLlmService } from '../interfaces/llm/sarvam/sarvam-llm.service';
import {
  LlmError,
  LlmProvider,
  LlmResult,
  LLM_PROVIDER_TO_MEDIA_SOURCE,
} from '../interfaces/llm/llm.dto';
import {
  COMPREHENSION_COMPLETE_STID_SUFFIX,
  COMPREHENSION_RUNTIME_STID_RE,
  FlowMediaPayload,
  GeneratedContent,
  LlmGenerateResponse,
  LlmOutputInvalidError,
  SENTENCE_COMPREHENSION_STID_SUFFIX,
  VALID_PASSAGE_TYPES,
  VALID_QUESTION_TYPES,
  comprehensionCompleteStid,
  comprehensionFlowStid,
  parseGeneratedContent,
  passageLevelFromWordCount,
  validateLlmGenerateRequest,
} from './llm-generate.dto';
import { oggOpusDurationMs } from './audio-duration.utils';
import {
  SOLVABILITY_REJECT_MIN_CORRECT,
  SOLVABILITY_REQUIRED_VALID,
  SolvabilityVerdict,
  runZeroContextSolvability,
  solvabilityGateApplies,
} from './zero-context-solvability';
import {
  JUDGE_REQUIRED_VALID,
  PassageJudgeVerdict,
  runPassageJudge,
} from './passage-judge';
import {
  PassageQualityVerdict,
  QUALITY_REQUIRED_VALID,
  runPassageQuality,
} from './passage-quality';
import { GATE_JUDGE_MODEL, pickGateObservability } from './gate-shared';
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
  VALID_MEDIA_TYPES,
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

// Word-carrying stids whose text media is auto-created on lookup miss
// (source='drill-word-auto'): the sentence→word drill hand-off plus the six
// letter-drill→word returns, all prefixed with the word. The word can be any
// Hindi word (not just word-list entries), so its text cannot be pre-seeded;
// the auto-created row shows the word alongside the generic (audio/video)
// prompt — these stids deliberately carry no seeded text (pre-literate
// pedagogy), so the specific-beats-generic merge cannot shadow anything.
// The prefix guard excludes the generic key ('_') and the fixed 'sentence-*'
// prompt stids, whose media is human-seeded.
// Passage-search gate filters (quality/judge/solvability), derived from the
// stored media_details records: quality from the passage row's
// quality.verdict; judge/solvability from the question row (gate_failure →
// failed; solvability.skipped → skipped; a stored record → passed; absent →
// not_run). Live search only shows rolled_back=false rows, so 'failed' is
// mostly future-proofing — failed families are soft-deleted.
export const GATE_FILTER_STATES = [
  'passed',
  'failed',
  'skipped',
  'not_run',
] as const;

const DRILL_WORD_STID_RE =
  /^([^-]+)-(?:sentence-word-drillWord|letter-word-correct-last|letterImage-word-(?:correct|maxErrors)-last|letterNoImage-word-(?:correct-first|correct-retry|wrong)-last)$/;
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
    private readonly openaiLlmService: OpenaiLlmService,
    private readonly anthropicLlmService: AnthropicLlmService,
    private readonly googleLlmService: GoogleLlmService,
    private readonly mistralLlmService: MistralLlmService,
    private readonly sarvamLlmService: SarvamLlmService,
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

    // Voice-note length straight off the Ogg container (no decode).
    // WhatsApp voice notes are audio/ogg; codecs=opus — other content types
    // have no cheap container clock, so duration is simply omitted.
    const isOggOpus =
      content_type.includes('ogg') || content_type.includes('opus');
    const durationMs = isOggOpus ? oggOpusDurationMs(audioBuffer) : null;
    if (isOggOpus && durationMs === null) {
      this.logger.warn(
        `createWhatsappAudioMedia: could not parse Ogg duration for ${entity.id} (content_type=${content_type})`,
      );
    }

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
      // After the spread so callers cannot override the measured value;
      // omitted entirely (never null) when the container yielded none.
      ...(durationMs !== null && { duration_ms: durationMs }),
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

    // Comprehension runtime stids (`${passageId}-sentence-comprehension-
    // correct-first|retry`) additionally resolve the flow rows stored under
    // `${passageId}-sentence-comprehension` — one flow per question, same
    // flow regardless of first/retry, random pick among the passage's
    // questions below. (The `_` generic key is useless for these: the prefix
    // is a UUID, so splitting at the first dash cuts inside it.)
    const comprehensionMatch =
      COMPREHENSION_RUNTIME_STID_RE.exec(stateTransitionId);
    const flowKey = comprehensionMatch
      ? comprehensionFlowStid(comprehensionMatch[1])
      : null;

    const cached =
      await this.cacheService.get<FindMediaByStateTransitionIdResult>(
        CACHE_KEYS.mediaByStateTransitionId(stateTransitionId),
      );
    if (cached) {
      return cached;
    }

    // Raw SQL — uses ANY($1::text[]) for multi-key lookup
    const keys = [stateTransitionId];
    if (genericKey) keys.push(genericKey);
    if (flowKey) keys.push(flowKey);
    const rows: MediaMetaData[] = await this.dataSource.query(
      `SELECT * FROM media_metadata
       WHERE state_transition_id = ANY($1::text[])
         AND status = 'ready'
         AND rolled_back = false
         AND (wa_media_url IS NOT NULL OR media_type IN ('text', 'flow'))`,
      [keys],
    );
    const specificByType = new Map<string, MediaMetaData[]>();
    const genericByType = new Map<string, MediaMetaData[]>();
    for (const row of rows) {
      // flowKey rows are passage-specific, not generic fallbacks.
      const bucket =
        row.state_transition_id === stateTransitionId ||
        (flowKey !== null && row.state_transition_id === flowKey)
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
      'flow',
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
    // Reading-speed stids are deliberately unseeded for now — an empty
    // lookup there is the designed no-op, not a missing-content signal.
    if (
      resultTypes.length === 0 &&
      !stateTransitionId.endsWith('-wpm-reading-speed')
    ) {
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

  // Provenance vs reference: the FK sweep in markRolledBack exists for the
  // inbound unit-of-work rollback — rows CAUSED BY processing a user message
  // all carry user_message_id and are hard-deleted with it (scores,
  // literacy_lesson_states). FK columns that merely REFERENCE a media row
  // must never be swept: literacy_lesson_states.passage_id (student lesson
  // history), media_metadata.input_media_id (derived children — soft-flagged
  // recursively instead), letters.media_metadata_id (letter catalog).
  // outbound_messages (audit log) is excluded by table, not column.
  private static readonly ROLLBACK_SWEEP_COLUMNS = ['user_message_id'];

  async markRolledBack(mediaId: string): Promise<void> {
    if (typeof mediaId !== 'string' || mediaId.length === 0) {
      throw new BadRequestException('mediaId must be a non-empty string');
    }

    // Fetch s3_key + state_transition_id before DB transaction
    const entity = await this.mediaRepo.findOneBy({ id: mediaId });
    const s3Key: string | null = entity?.s3_key ?? null;
    const stid: string | null = entity?.state_transition_id ?? null;
    const stidsToInvalidate = new Set<string>();
    if (stid) {
      stidsToInvalidate.add(stid);
    }

    await this.dataSource.transaction(async (manager) => {
      // TypeORM's pg manager.query returns [rowsArray, affectedCount] for
      // UPDATE/INSERT/DELETE — affectedCount is the second element.
      // Unconditional so a re-rollback stays a 200, not a 404.
      const [, affected]: [unknown[], number] = await manager.query(
        `UPDATE media_metadata SET rolled_back = true WHERE id = $1`,
        [mediaId],
      );
      if (affected === 0) {
        throw new NotFoundException('Media metadata not found');
      }

      // rolled_back IS the delete: the derivation subtree (questions →
      // options → explanations → flows, TTS audio, STT transcripts —
      // everything reachable over input_media_id) is soft-flagged with its
      // root, never hard-deleted. Hard deletes would destroy provenance and
      // are blocked anyway by outbound_messages FKs for anything ever sent.
      // Descendants' S3 objects are deliberately NOT deleted here: direct
      // callers (deleteByStateTransitionId) invoke markRolledBack per
      // subtree row for that, and inbound STT transcripts have no S3 object.
      const [descendants]: [
        Array<{ id: string; state_transition_id: string | null }>,
        number,
      ] = await manager.query(
        `WITH RECURSIVE subtree AS (
           SELECT id FROM media_metadata WHERE id = $1
           UNION ALL
           SELECT m.id FROM media_metadata m
           JOIN subtree s ON m.input_media_id = s.id
         )
         UPDATE media_metadata SET rolled_back = true
         WHERE id IN (SELECT id FROM subtree)
           AND id <> $1
           AND rolled_back = false
         RETURNING id, state_transition_id`,
        [mediaId],
      );
      for (const d of descendants) {
        if (d.state_transition_id) {
          stidsToInvalidate.add(d.state_transition_id);
        }
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
      // The attname filter restricts the sweep to provenance FKs (see
      // ROLLBACK_SWEEP_COLUMNS) — reference FKs must survive a rollback.
      const fkStmts: { sql: string }[] = await manager.query(
        `SELECT format('DELETE FROM %s WHERE %I = $1', con.conrelid::regclass, att.attname) AS sql
         FROM pg_constraint con
         JOIN pg_attribute att
           ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
         WHERE con.confrelid = 'media_metadata'::regclass
           AND con.contype = 'f'
           AND con.conrelid <> 'outbound_messages'::regclass
           AND att.attname = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM pg_attribute pa
             WHERE pa.attrelid = con.confrelid
               AND pa.attnum = ANY(con.confkey)
               AND pa.attname = 'id'
           )`,
        [MediaMetaDataService.ROLLBACK_SWEEP_COLUMNS],
      );

      for (const { sql } of fkStmts) {
        await manager.query(sql, [mediaId]);
      }
    });

    // Invalidate STID caches (root + every soft-flagged descendant) so
    // readers don't keep serving rolled-back rows.
    for (const key of stidsToInvalidate) {
      await this.cacheService.del(CACHE_KEYS.mediaByStateTransitionId(key));
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
        state_transition_id: item.state_transition_id ?? null,
        wa_media_url: null,
        status: 'created',
        media_type: 'audio',
        source: 'elevenlabs',
        user_id: null,
        rolled_back: false,
        // Mirrors the STT direction (transcript rows link to their source
        // audio): TTS audio links to its source text row when one exists.
        input_media_id: item.input_media_id ?? null,
        generation_request_json: {
          script_text: item.script_text,
          state_transition_id: item.state_transition_id ?? null,
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

  private llmServiceFor(provider: LlmProvider) {
    switch (provider) {
      case 'openai':
        return this.openaiLlmService;
      case 'anthropic':
        return this.anthropicLlmService;
      case 'google':
        return this.googleLlmService;
      case 'mistral':
        return this.mistralLlmService;
      case 'sarvam':
        return this.sarvamLlmService;
    }
  }

  /**
   * Seeds reading-comprehension media from one LLM completion. Synchronous by
   * design (no queue): one dashboard request = one generation (one passage
   * with exactly ONE question) = one response, with a structured outcome so
   * the user sees what failed, why, and whether retrying can help.
   *
   * Gate order, cheap-first — a question failing an earlier gate never
   * reaches a later one, so the funnel counts are disjoint:
   *   1. validate request → LLM completion
   *   2. parse/validate the untrusted JSON (llm-generate.dto) — DTO shape
   *   3. passage-judge gate (10 valid GATE_JUDGE_MODEL runs over ≤14 calls,
   *      with passage)
   *   4. zero-context solvability (24 valid runs over ≤50 calls, no
   *      passage; narrative R1.1–R1.3 questions only — everything else
   *      skips it with media_details.solvability.skipped = true)
   *   5. transactional insert of the entity tree (passage → question →
   *      options → explanations + one flow row)
   *   6. ElevenLabs TTS enqueue for EVERY text entity (passage, question,
   *      each option, each explanation) — one audio row per text entity,
   *      never concatenated clips (options are shuffled per send, so a
   *      combined question+options clip would contradict runtime ordering).
   *
   * A question failing gate 3 or 4 is NOT discarded: the whole family is
   * persisted with rolled_back = true and a media_details.gate_failure record
   * on the question row (surfaced by GET generation-failures) so failures can
   * be troubleshooted. Soft-deleted content never gets audio.
   */
  async createLlmGeneratedMedia(
    body: unknown,
    otel_carrier: OtelCarrier,
  ): Promise<LlmGenerateResponse> {
    const request = validateLlmGenerateRequest(body);
    const span = trace.getActiveSpan();
    span?.setAttribute('pp.llm.provider', request.provider);
    span?.setAttribute('pp.llm.model', request.model);

    const llmService = this.llmServiceFor(request.provider);

    // 1. Generation call.
    let completion: LlmResult;
    try {
      completion = await llmService.complete({
        model: request.model,
        messages: request.messages,
      });
    } catch (err) {
      if (err instanceof LlmError) {
        this.logger.warn(
          `llm-generate: ${request.provider}/${request.model} failed: ${err.message}`,
        );
        return {
          status: 'failed',
          reason: err.message,
          retriable: err.retriable,
        };
      }
      throw err;
    }

    // 2. Parse + validate the untrusted completion (DTO-shape gate).
    let content: GeneratedContent;
    try {
      content = parseGeneratedContent(completion.text);
    } catch (err) {
      if (err instanceof LlmOutputInvalidError) {
        this.logger.warn(
          `llm-generate: invalid completion from ${request.provider}/${request.model}: ${err.message}`,
        );
        // A fresh sample may well pass validation — retriable.
        return { status: 'rejected', reason: err.message, retriable: true };
      }
      throw err;
    }
    const question = content.question;

    const level = passageLevelFromWordCount(content.passage.text);
    span?.setAttribute('pp.llm.passage_level', level);

    // 2b. Passage-quality gate — cheapest first: scores the passage TEXT
    // alone (5 valid true/false votes over ≤8 calls, pass = ≥3 true). A
    // fail still persists the family soft-deleted like the other gate
    // failures, but skips the later, more expensive gates.
    let qualityVerdict: PassageQualityVerdict;
    try {
      qualityVerdict = await runPassageQuality(
        this.sarvamLlmService,
        content.passage.text,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'rejected',
        reason: `passage-quality gate errored: ${message}`,
        retriable: true,
        level,
        question: {
          status: 'unverified',
          reason: `passage-quality gate errored: ${message}`,
        },
      };
    }
    const qualityReport = {
      ...(qualityVerdict.true_votes !== undefined && {
        true_votes: qualityVerdict.true_votes,
      }),
      valid_runs: qualityVerdict.valid_runs,
      total_calls: qualityVerdict.total_calls,
      call_failures: qualityVerdict.call_failures,
      unparseable: qualityVerdict.unparseable,
    };
    if (qualityVerdict.status === 'unverified') {
      const reason = `passage-quality unverified: ${qualityVerdict.valid_runs}/${QUALITY_REQUIRED_VALID} valid after ${qualityVerdict.total_calls} ${GATE_JUDGE_MODEL} calls (${qualityVerdict.call_failures} call failures, ${qualityVerdict.unparseable} unparseable) — retry`;
      return {
        status: 'rejected',
        reason,
        retriable: true,
        level,
        question: { status: 'unverified', reason, quality: qualityReport },
      };
    }
    const qualityFailed = qualityVerdict.status === 'failed_quality';

    // 3. Passage-judge gate (with passage) — skipped entirely when quality
    // already failed the family (cheap-first; funnel counts stay disjoint).
    let judgeVerdict: PassageJudgeVerdict | null = null;
    if (!qualityFailed) {
      try {
        judgeVerdict = await runPassageJudge(
          this.sarvamLlmService,
          content.passage.text,
          question,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'rejected',
          reason: `passage-judge gate errored: ${message}`,
          retriable: true,
          level,
          question: {
            status: 'unverified',
            reason: `passage-judge gate errored: ${message}`,
          },
        };
      }
      if (judgeVerdict.status === 'unverified') {
        const reason = `passage-judge unverified: ${judgeVerdict.valid_runs}/${JUDGE_REQUIRED_VALID} valid after ${judgeVerdict.total_calls} ${GATE_JUDGE_MODEL} calls (${judgeVerdict.call_failures} call failures, ${judgeVerdict.unparseable} unparseable) — retry`;
        return {
          status: 'rejected',
          reason,
          retriable: true,
          level,
          question: {
            status: 'unverified',
            reason,
            judge: pickGateObservability(judgeVerdict),
            quality: qualityReport,
          },
        };
      }
    }

    // 4. Zero-context solvability (no passage) — only for judge-passed
    // questions, so the funnel counts stay disjoint, and only for narrative
    // R1.1–R1.3 questions (2026-08 scope-down); everything else records
    // media_details.solvability.skipped = true instead of a verdict.
    const solvabilityApplies = solvabilityGateApplies(
      content.passage.passage_type,
      question.question_type,
    );
    let solvabilityVerdict: SolvabilityVerdict | null = null;
    if (
      judgeVerdict !== null &&
      judgeVerdict.status === 'passed' &&
      solvabilityApplies
    ) {
      try {
        solvabilityVerdict = await runZeroContextSolvability(
          this.sarvamLlmService,
          question,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'rejected',
          reason: `solvability filter errored: ${message}`,
          retriable: true,
          level,
          question: {
            status: 'unverified',
            reason: `solvability filter errored: ${message}`,
          },
        };
      }
      if (solvabilityVerdict.status === 'unverified') {
        const reason = `solvability unverified: ${solvabilityVerdict.valid_runs}/${SOLVABILITY_REQUIRED_VALID} valid after ${solvabilityVerdict.total_calls} ${GATE_JUDGE_MODEL} calls (${solvabilityVerdict.call_failures} call failures, ${solvabilityVerdict.unparseable} unparseable) — retry`;
        return {
          status: 'rejected',
          reason,
          retriable: true,
          level,
          question: {
            status: 'unverified',
            reason,
            judge: pickGateObservability(judgeVerdict),
            solvability: pickGateObservability(solvabilityVerdict),
          },
        };
      }
    }

    // The question's fate: live insert, or soft-deleted insert with a
    // gate_failure record for troubleshooting.
    let gateFailure: {
      gate: 'quality' | 'judge' | 'solvability';
      reason: string;
      [k: string]: unknown;
    } | null = null;
    if (qualityFailed) {
      gateFailure = {
        gate: 'quality',
        reason: `passage-quality: ${qualityVerdict.true_votes ?? 0}/${QUALITY_REQUIRED_VALID} true`,
        true_votes: qualityVerdict.true_votes,
        valid_runs: qualityVerdict.valid_runs,
        total_calls: qualityVerdict.total_calls,
        call_failures: qualityVerdict.call_failures,
        unparseable: qualityVerdict.unparseable,
        model: GATE_JUDGE_MODEL,
      };
    } else if (judgeVerdict && judgeVerdict.status === 'failed_judge') {
      gateFailure = {
        gate: 'judge',
        reason: `passage-judge: ${judgeVerdict.wrong_picks!.length} of ${judgeVerdict.valid_runs} valid runs picked a wrong option`,
        // Original option-array indices per miss: a judge consistently
        // picking the same wrong option means the answer key is wrong.
        judge_picks: judgeVerdict.wrong_picks,
        ...pickGateObservability(judgeVerdict),
        model: GATE_JUDGE_MODEL,
      };
    } else if (solvabilityVerdict?.status === 'failed_solvable') {
      const minCorrect =
        SOLVABILITY_REJECT_MIN_CORRECT[question.options.length as 2 | 3 | 4];
      gateFailure = {
        gate: 'solvability',
        reason: `zero-context solvable: correct answer picked ${solvabilityVerdict.correct} of ${solvabilityVerdict.valid_runs} valid runs (rejection minimum ${minCorrect} for ${question.options.length} options)`,
        ...pickGateObservability(solvabilityVerdict),
        model: GATE_JUDGE_MODEL,
      };
    }
    const rolledBack = gateFailure !== null;

    // 5. Build the entity tree with server-minted ids only.
    const source = LLM_PROVIDER_TO_MEDIA_SOURCE[request.provider];
    assertValidMediaSource(source);
    const passageId = uuid();
    const questionId = uuid();
    const entities: MediaMetaDataEntity[] = [];
    // One audio row per text entity. state_transition_id only where the
    // source text row has one (explanations); every audio row links to its
    // source text row via input_media_id — symmetric with the STT direction
    // (sarvam/reverie transcripts link to their source audio the same way).
    const ttsItems: Array<{
      state_transition_id: string | null;
      script_text: string;
      input_media_id: string;
    }> = [];

    entities.push(
      this.mediaRepo.create({
        id: passageId,
        media_type: 'text',
        source,
        status: 'ready',
        text: content.passage.text,
        rolled_back: rolledBack,
        media_details: {
          role: 'passage',
          level,
          passage_type: content.passage.passage_type,
          model: request.model,
          prompt_tokens: completion.prompt_tokens,
          completion_tokens: completion.completion_tokens,
          // Quality verdict is recorded whatever the outcome that reaches
          // an insert (pass or fail — unverified never inserts). The
          // dashboard filters on exactly this shape.
          quality: {
            version: 1,
            verdict: qualityFailed ? 'fail' : 'pass',
            true_votes: qualityVerdict.true_votes,
            runs: qualityVerdict.runs,
            valid_runs: qualityVerdict.valid_runs,
            total_calls: qualityVerdict.total_calls,
            call_failures: qualityVerdict.call_failures,
            unparseable: qualityVerdict.unparseable,
          },
        },
        generation_request_json: {
          provider: request.provider,
          model: request.model,
          messages: request.messages,
        },
      }),
    );
    ttsItems.push({
      state_transition_id: null,
      script_text: content.passage.text,
      input_media_id: passageId,
    });

    entities.push(
      this.mediaRepo.create({
        id: questionId,
        media_type: 'text',
        source,
        status: 'ready',
        text: question.text,
        input_media_id: passageId,
        rolled_back: rolledBack,
        media_details: {
          role: 'question',
          question_type: question.question_type,
          model: request.model,
          // Judge never runs when quality already failed the family.
          ...(judgeVerdict && {
            judge: {
              ...pickGateObservability(judgeVerdict),
              model: GATE_JUDGE_MODEL,
            },
          }),
          ...(solvabilityVerdict
            ? {
                solvability: {
                  ...pickGateObservability(solvabilityVerdict),
                  model: GATE_JUDGE_MODEL,
                },
              }
            : // Distinguishes "gate out of scope" from "never reached the
              // gate" (judge failure) in the generation-failures funnel.
              !solvabilityApplies && { solvability: { skipped: true } }),
          ...(gateFailure && { gate_failure: gateFailure }),
        },
      }),
    );
    ttsItems.push({
      state_transition_id: null,
      script_text: question.text,
      input_media_id: questionId,
    });

    const flowOptions: FlowMediaPayload['options'] = [];
    for (const option of question.options) {
      const optionId = uuid();
      flowOptions.push({
        id: optionId,
        text: option.text,
        correct: option.correct,
      });
      entities.push(
        this.mediaRepo.create({
          id: optionId,
          media_type: 'text',
          source,
          status: 'ready',
          text: option.text,
          input_media_id: questionId,
          rolled_back: rolledBack,
          media_details: {
            role: 'option',
            correct: option.correct,
            model: request.model,
          },
        }),
      );
      ttsItems.push({
        state_transition_id: null,
        script_text: option.text,
        input_media_id: optionId,
      });

      const explanationId = uuid();
      entities.push(
        this.mediaRepo.create({
          id: explanationId,
          media_type: 'text',
          source,
          status: 'ready',
          text: option.explanation.text,
          input_media_id: optionId,
          state_transition_id: comprehensionCompleteStid(optionId),
          rolled_back: rolledBack,
          media_details: {
            role: 'explanation',
            model: request.model,
          },
        }),
      );
      // Explanation audio keeps the stid — it is the only audio delivered
      // today (via `${optionId}-comprehension-complete`); passage/question/
      // option audio is generation-only (input_media_id, no stid).
      ttsItems.push({
        state_transition_id: comprehensionCompleteStid(optionId),
        script_text: option.explanation.text,
        input_media_id: explanationId,
      });
    }

    if (question.send_as_flow) {
      const payload: FlowMediaPayload = {
        question_text: question.text,
        options: flowOptions,
      };
      entities.push(
        this.mediaRepo.create({
          id: uuid(),
          media_type: 'flow',
          source,
          status: 'ready',
          text: JSON.stringify(payload),
          input_media_id: questionId,
          state_transition_id: comprehensionFlowStid(passageId),
          rolled_back: rolledBack,
          media_details: {
            role: 'flow',
            question_type: question.question_type,
            model: request.model,
          },
        }),
      );
    }

    // 6. All-or-nothing insert.
    await this.dataSource.transaction(async (manager) => {
      await manager.save(entities);
    });
    span?.setAttribute('pp.llm.entities_created', entities.length);

    if (gateFailure) {
      this.logger.log(
        `llm-generate: soft-deleted passage ${passageId} (level ${level}) — ${gateFailure.reason}`,
      );
      return {
        status: 'rejected',
        reason: gateFailure.reason,
        // The content is persisted for troubleshooting, but a fresh sample
        // may well pass the gates.
        retriable: true,
        passage_id: passageId,
        level,
        question: {
          status: 'discarded',
          reason: gateFailure.reason,
          question_id: questionId,
          quality: qualityReport,
          ...(judgeVerdict && { judge: pickGateObservability(judgeVerdict) }),
          ...(solvabilityVerdict && {
            solvability: pickGateObservability(solvabilityVerdict),
          }),
        },
      };
    }

    this.logger.log(
      `llm-generate: created passage ${passageId} (level ${level}) with its question from ${request.provider}/${request.model}`,
    );

    // 7. TTS fan-out through the existing ElevenLabs pathway (transcript ends
    // up in generation_request_json.script_text per that pipeline's
    // contract). Live content only — never audio for soft-deleted rows.
    const response: LlmGenerateResponse = {
      status: 'created',
      passage_id: passageId,
      level,
      question: {
        status: 'created',
        question_id: questionId,
        quality: qualityReport,
        ...(judgeVerdict && { judge: pickGateObservability(judgeVerdict) }),
        ...(solvabilityVerdict && {
          solvability: pickGateObservability(solvabilityVerdict),
        }),
      },
    };
    try {
      await this.createElevenlabsMedia({ items: ttsItems }, otel_carrier);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `llm-generate: text entities created but TTS enqueue failed for passage ${passageId}: ${message}`,
      );
      response.tts_error = `audio generation failed to start: ${message}`;
    }
    return response;
  }

  /**
   * Recent gate-failed generations for the dashboard's read-only "Filter
   * failures" list: question rows carrying media_details.gate_failure, newest
   * first, joined to their parent passage for preview and to their option
   * rows (children via input_media_id with role 'option', aggregated in
   * creation order) — seeing the correct option next to its distractors is
   * how a solvability rejection is diagnosed. These rows are intentionally
   * rolled_back = true (soft-deleted at creation because they failed the
   * judge or solvability gate; their options likewise) — the usual
   * rolled_back = false visibility filter is deliberately NOT applied here.
   */
  async listGenerationFailures(options: { limit?: number }): Promise<{
    items: Array<{
      question_id: string;
      question_text: string | null;
      question_type: string | null;
      gate_failure: Record<string, unknown>;
      solvability: Record<string, unknown> | null;
      options: Array<{ text: string | null; correct: boolean }>;
      passage_id: string | null;
      passage_preview: string | null;
      level: number | null;
      created_at: Date;
    }>;
  }> {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
    const rows: Array<{
      question_id: string;
      question_text: string | null;
      media_details: Record<string, unknown> | null;
      options: Array<{ text: string | null; correct: boolean }> | null;
      passage_id: string | null;
      passage_preview: string | null;
      level: string | null;
      created_at: Date;
    }> = await this.dataSource.query(
      `SELECT q.id AS question_id, q.text AS question_text, q.media_details,
              p.id AS passage_id, LEFT(p.text, 300) AS passage_preview,
              p.media_details->>'level' AS level, q.created_at,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'text', o.text,
                        'correct',
                        COALESCE((o.media_details->>'correct')::boolean, false))
                      ORDER BY o.created_at), '[]'::jsonb)
               FROM media_metadata o
               WHERE o.input_media_id = q.id
                 AND o.media_details->>'role' = 'option') AS options
       FROM media_metadata q
       LEFT JOIN media_metadata p ON p.id = q.input_media_id
       WHERE q.media_details ? 'gate_failure'
       ORDER BY q.created_at DESC
       LIMIT $1`,
      [limit],
    );
    return {
      items: rows.map((r) => ({
        question_id: r.question_id,
        question_text: r.question_text,
        question_type: (r.media_details?.question_type as string) ?? null,
        gate_failure:
          (r.media_details?.gate_failure as Record<string, unknown>) ?? {},
        solvability:
          (r.media_details?.solvability as Record<string, unknown>) ?? null,
        options: r.options ?? [],
        passage_id: r.passage_id,
        passage_preview: r.passage_preview,
        level: r.level === null ? null : parseInt(r.level, 10),
        created_at: r.created_at,
      })),
    };
  }

  /**
   * Paginated distinct comprehension stids (flow rows' `…-sentence-
   * comprehension` and explanation rows' `…-comprehension-complete`) for the
   * dashboard table. Grows with the passage count — always paginate.
   */
  async listComprehensionStids(options: {
    limit?: number;
    offset?: number;
  }): Promise<{
    rows: Array<{
      state_transition_id: string;
      media_count: number;
      created_at: Date;
      level: number | null;
      passage_type: string | null;
      question_type: string | null;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);

    const where = `rolled_back = false
         AND state_transition_id IS NOT NULL
         AND (state_transition_id LIKE '%-sentence-comprehension'
           OR state_transition_id LIKE '%-comprehension-complete')`;
    const rows: Array<{
      state_transition_id: string;
      media_count: string;
      created_at: Date;
    }> = await this.dataSource.query(
      `SELECT state_transition_id, COUNT(*) AS media_count,
              MIN(created_at) AS created_at
       FROM media_metadata
       WHERE ${where}
       GROUP BY state_transition_id
       ORDER BY MIN(created_at) DESC, state_transition_id
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const totals: Array<{ total: string }> = await this.dataSource.query(
      `SELECT COUNT(DISTINCT state_transition_id) AS total
       FROM media_metadata
       WHERE ${where}`,
    );

    const meta = await this.comprehensionStidMeta(
      rows.map((r) => r.state_transition_id),
    );

    return {
      rows: rows.map((r) => {
        const m = meta.get(r.state_transition_id);
        return {
          state_transition_id: r.state_transition_id,
          media_count: parseInt(r.media_count, 10),
          created_at: r.created_at,
          level: m?.level ?? null,
          passage_type: m?.passage_type ?? null,
          question_type: m?.question_type ?? null,
        };
      }),
      total: parseInt(totals[0]?.total ?? '0', 10),
      limit,
      offset,
    };
  }

  /**
   * Passage level/type + question type per comprehension stid, so the
   * dashboard table can badge rows. Two batch lookups keyed on the stid
   * prefix: a `…-sentence-comprehension` prefix IS the passage id (1 hop to
   * its question), a `…-comprehension-complete` prefix is the tapped
   * option's id (2 hops up: option → question → passage). Missing family
   * rows (partially deleted content) resolve to nulls, never an error.
   */
  private async comprehensionStidMeta(stids: string[]): Promise<
    Map<
      string,
      {
        level: number | null;
        passage_type: string | null;
        question_type: string | null;
      }
    >
  > {
    const FLOW_SUFFIX = `-${SENTENCE_COMPREHENSION_STID_SUFFIX}`;
    const EXPL_SUFFIX = `-${COMPREHENSION_COMPLETE_STID_SUFFIX}`;
    const passageIds: string[] = [];
    const optionIds: string[] = [];
    for (const stid of stids) {
      if (stid.endsWith(FLOW_SUFFIX)) {
        passageIds.push(stid.slice(0, -FLOW_SUFFIX.length));
      } else if (stid.endsWith(EXPL_SUFFIX)) {
        optionIds.push(stid.slice(0, -EXPL_SUFFIX.length));
      }
    }
    interface MetaRow {
      key: string;
      level: number | null;
      passage_type: string | null;
      question_type: string | null;
    }
    const meta = new Map<string, Omit<MetaRow, 'key'>>();
    if (passageIds.length > 0) {
      const found: MetaRow[] = await this.dataSource.query(
        `SELECT p.id::text AS key,
                (p.media_details->>'level')::int AS level,
                p.media_details->>'passage_type' AS passage_type,
                q.media_details->>'question_type' AS question_type
         FROM media_metadata p
         LEFT JOIN media_metadata q
           ON q.input_media_id = p.id
          AND q.media_details->>'role' = 'question'
          AND q.rolled_back = false
         WHERE p.id::text = ANY($1::text[]) AND p.rolled_back = false`,
        [passageIds],
      );
      for (const m of found) meta.set(m.key + FLOW_SUFFIX, m);
    }
    if (optionIds.length > 0) {
      const found: MetaRow[] = await this.dataSource.query(
        `SELECT o.id::text AS key,
                (p.media_details->>'level')::int AS level,
                p.media_details->>'passage_type' AS passage_type,
                q.media_details->>'question_type' AS question_type
         FROM media_metadata o
         JOIN media_metadata q ON q.id = o.input_media_id
         LEFT JOIN media_metadata p ON p.id = q.input_media_id
         WHERE o.id::text = ANY($1::text[]) AND o.rolled_back = false`,
        [optionIds],
      );
      for (const m of found) meta.set(m.key + EXPL_SUFFIX, m);
    }
    return meta;
  }

  /**
   * Live passage inventory for the dashboard's seeding counters: ready,
   * non-rolled-back passages counted per (level, passage_type,
   * question_type). question_type lives on the linked question row
   * (q.input_media_id = passage id; 1:1 for live content).
   */
  async getPassageStats(): Promise<{
    rows: Array<{
      level: number | null;
      passage_type: string | null;
      question_type: string | null;
      passages: number;
    }>;
  }> {
    const rows: Array<{
      level: number | null;
      passage_type: string | null;
      question_type: string | null;
      passages: string;
    }> = await this.dataSource.query(
      `SELECT (p.media_details->>'level')::int  AS level,
              p.media_details->>'passage_type'  AS passage_type,
              q.media_details->>'question_type' AS question_type,
              COUNT(*)                          AS passages
       FROM media_metadata p
       LEFT JOIN media_metadata q
         ON q.input_media_id = p.id
        AND q.media_details->>'role' = 'question'
        AND q.rolled_back = false
       WHERE p.media_type = 'text'
         AND p.status = 'ready'
         AND p.rolled_back = false
         AND p.media_details->>'role' = 'passage'
       GROUP BY 1, 2, 3
       ORDER BY 1, 2, 3`,
    );
    return {
      rows: rows.map((r) => ({
        level: r.level,
        passage_type: r.passage_type,
        question_type: r.question_type,
        passages: parseInt(r.passages, 10),
      })),
    };
  }

  /**
   * Merges a passage-quality record into a passage row's media_details.
   * Used by the retro sweep (src/scripts/passage-quality-sweep.ts) so
   * re-runs reuse stored verdicts instead of re-judging; the pipeline
   * writes the same shape inline at insert time.
   */
  async recordPassageQuality(
    passageId: string,
    quality: Record<string, unknown>,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE media_metadata
       SET media_details = COALESCE(media_details, '{}'::jsonb)
         || jsonb_build_object('quality', $2::jsonb)
       WHERE id = $1`,
      [passageId, JSON.stringify(quality)],
    );
  }

  /**
   * Live media counts grouped by (stid, media_type) for every stid ending in
   * `suffix` — one query for a whole stid family (e.g. the 203
   * `…-wpm-reading-speed` rows), so the dashboard never fans out per-stid
   * requests. Suffix match uses right()/length(), deliberately NOT LIKE:
   * '_' in a suffix like '_-wpm-reading-speed' is a LIKE wildcard and must
   * match literally.
   */
  async getStidCountsBySuffix(
    suffix: unknown,
  ): Promise<
    Array<{ state_transition_id: string; media_type: string; count: number }>
  > {
    if (typeof suffix !== 'string' || suffix.length === 0) {
      throw new BadRequestException('suffix must be a non-empty string');
    }
    if (suffix.length > 64) {
      throw new BadRequestException('suffix must be at most 64 chars');
    }
    const rows: Array<{
      state_transition_id: string;
      media_type: string;
      count: number;
    }> = await this.dataSource.query(
      `SELECT state_transition_id, media_type, COUNT(*)::int AS count
       FROM media_metadata
       WHERE right(state_transition_id, length($1)) = $1 AND rolled_back = false
       GROUP BY 1, 2`,
      [suffix],
    );
    return rows.map((r) => ({
      state_transition_id: r.state_transition_id,
      media_type: r.media_type,
      count: Number(r.count),
    }));
  }

  /**
   * Paginated passage search for the dashboard: substring match on the
   * passage text (ILIKE, wildcards escaped) plus optional passage_type /
   * question_type filters, a media_type filter over the passage's live
   * derivation subtree (e.g. 'flow' = has a sendable comprehension
   * question), and created_after / created_before bounds on the passage
   * row's created_at. Newest first. Same visibility rules as
   * getPassageStats; same pagination contract as listComprehensionStids.
   */
  async searchPassages(options: {
    q?: string;
    passage_type?: string;
    question_type?: string;
    media_type?: string;
    created_after?: string;
    created_before?: string;
    quality?: string;
    judge?: string;
    solvability?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    rows: Array<{
      id: string;
      level: number | null;
      passage_type: string | null;
      question_type: string | null;
      model: string | null;
      preview: string;
      created_at: Date;
      quality: Record<string, unknown> | null;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const passageType = options.passage_type?.trim() || null;
    if (
      passageType !== null &&
      !(VALID_PASSAGE_TYPES as readonly string[]).includes(passageType)
    ) {
      throw new BadRequestException(
        `passage_type must be one of: ${VALID_PASSAGE_TYPES.join(', ')}`,
      );
    }
    const questionType = options.question_type?.trim() || null;
    if (
      questionType !== null &&
      !(VALID_QUESTION_TYPES as readonly string[]).includes(questionType)
    ) {
      throw new BadRequestException(
        `question_type must be one of: ${VALID_QUESTION_TYPES.join(', ')}`,
      );
    }
    const mediaType = options.media_type?.trim() || null;
    if (
      mediaType !== null &&
      !(VALID_MEDIA_TYPES as readonly string[]).includes(mediaType)
    ) {
      throw new BadRequestException(
        `media_type must be one of: ${VALID_MEDIA_TYPES.join(', ')}`,
      );
    }
    const parseDate = (raw: string | undefined, name: string): Date | null => {
      if (raw === undefined || raw.trim() === '') return null;
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException(`${name} must be an ISO date/timestamp`);
      }
      return parsed;
    };
    const createdAfter = parseDate(options.created_after, 'created_after');
    const createdBefore = parseDate(options.created_before, 'created_before');
    const parseGateFilter = (
      raw: string | undefined,
      name: string,
    ): string | null => {
      const value = raw?.trim() || null;
      if (
        value !== null &&
        !GATE_FILTER_STATES.includes(
          value as (typeof GATE_FILTER_STATES)[number],
        )
      ) {
        throw new BadRequestException(
          `${name} must be one of: ${GATE_FILTER_STATES.join(', ')}`,
        );
      }
      return value;
    };
    const qualityFilter = parseGateFilter(options.quality, 'quality');
    const judgeFilter = parseGateFilter(options.judge, 'judge');
    const solvabilityFilter = parseGateFilter(
      options.solvability,
      'solvability',
    );
    // ILIKE pattern with user wildcards neutralized; empty q → match all.
    const q = (options.q ?? '').trim().slice(0, 200);
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;

    const joins = `FROM media_metadata p
       LEFT JOIN media_metadata q
         ON q.input_media_id = p.id
        AND q.media_details->>'role' = 'question'
        AND q.rolled_back = false`;
    // media_type filter: a passage matches when any LIVE row of its
    // derivation subtree (question → options → explanations → flows, TTS
    // audio) carries that media_type — 'flow' answers "which passages have
    // a sendable comprehension question".
    const where = `p.media_type = 'text'
         AND p.status = 'ready'
         AND p.rolled_back = false
         AND p.media_details->>'role' = 'passage'
         AND p.text ILIKE $1 ESCAPE '\\'
         AND ($2::text IS NULL OR p.media_details->>'passage_type' = $2)
         AND ($3::text IS NULL OR q.media_details->>'question_type' = $3)
         AND ($4::text IS NULL OR EXISTS (
           WITH RECURSIVE fam AS (
             SELECT id, media_type FROM media_metadata WHERE id = p.id
             UNION ALL
             SELECT m.id, m.media_type
             FROM media_metadata m JOIN fam f ON m.input_media_id = f.id
             WHERE m.rolled_back = false
           )
           SELECT 1 FROM fam WHERE media_type = $4
         ))
         AND ($5::timestamptz IS NULL OR p.created_at >= $5)
         AND ($6::timestamptz IS NULL OR p.created_at <= $6)
         AND ($7::text IS NULL OR (
           CASE
             WHEN p.media_details->'quality'->>'verdict' = 'pass' THEN 'passed'
             WHEN p.media_details->'quality'->>'verdict' = 'fail' THEN 'failed'
             ELSE 'not_run'
           END) = $7)
         AND ($8::text IS NULL OR (
           CASE
             WHEN q.media_details->'gate_failure'->>'gate' = 'judge' THEN 'failed'
             WHEN q.media_details ? 'judge' THEN 'passed'
             ELSE 'not_run'
           END) = $8)
         AND ($9::text IS NULL OR (
           CASE
             WHEN q.media_details->'gate_failure'->>'gate' = 'solvability' THEN 'failed'
             WHEN q.media_details->'solvability'->>'skipped' = 'true' THEN 'skipped'
             WHEN q.media_details ? 'solvability' THEN 'passed'
             ELSE 'not_run'
           END) = $9)`;
    const rows: Array<{
      id: string;
      level: number | null;
      passage_type: string | null;
      question_type: string | null;
      model: string | null;
      preview: string;
      created_at: Date;
      quality: Record<string, unknown> | null;
    }> = await this.dataSource.query(
      `SELECT p.id,
              (p.media_details->>'level')::int  AS level,
              p.media_details->>'passage_type'  AS passage_type,
              q.media_details->>'question_type' AS question_type,
              p.media_details->>'model'         AS model,
              left(p.text, 200)                 AS preview,
              p.created_at,
              p.media_details->'quality'        AS quality
       ${joins}
       WHERE ${where}
       ORDER BY p.created_at DESC, p.id
       LIMIT $10 OFFSET $11`,
      [
        pattern,
        passageType,
        questionType,
        mediaType,
        createdAfter,
        createdBefore,
        qualityFilter,
        judgeFilter,
        solvabilityFilter,
        limit,
        offset,
      ],
    );
    const totals: Array<{ total: string }> = await this.dataSource.query(
      `SELECT COUNT(*) AS total ${joins} WHERE ${where}`,
      [
        pattern,
        passageType,
        questionType,
        mediaType,
        createdAfter,
        createdBefore,
        qualityFilter,
        judgeFilter,
        solvabilityFilter,
      ],
    );
    return {
      rows,
      total: parseInt(totals[0]?.total ?? '0', 10),
      limit,
      offset,
    };
  }

  /**
   * Rolls back every media row carrying the stid. For `…-sentence-
   * comprehension` stids the whole passage family is rolled back (passage →
   * questions → options → explanations → flows): the stid prefix IS the
   * passage id. Rollback is a pure soft delete (rolled_back = true, the
   * single visibility flag); the per-row markRolledBack calls also handle
   * each row's S3 object and stid-cache invalidation, which is why the walk
   * visits every subtree row rather than relying on markRolledBack's own
   * recursive descendant flag. Deepest-first ordering is retained but no
   * longer load-bearing (nothing hard-deletes children anymore).
   */
  async deleteByStateTransitionId(
    stateTransitionId: string,
  ): Promise<{ deleted: number }> {
    if (
      typeof stateTransitionId !== 'string' ||
      stateTransitionId.length === 0
    ) {
      throw new BadRequestException(
        'stateTransitionId must be a non-empty string',
      );
    }

    const direct: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM media_metadata
       WHERE state_transition_id = $1 AND rolled_back = false`,
      [stateTransitionId],
    );
    if (direct.length === 0) {
      throw new NotFoundException(
        `No media found for state_transition_id ${stateTransitionId}`,
      );
    }

    const flowSuffix = '-sentence-comprehension';
    const rootIds = stateTransitionId.endsWith(flowSuffix)
      ? [stateTransitionId.slice(0, -flowSuffix.length)]
      : direct.map((r) => r.id);

    // TTS audio rows carry input_media_id to their source text row (same
    // convention as STT transcripts), so the FK walk reaches everything —
    // no orphan-audio-by-stid sweep needed.
    const subtree: Array<{ id: string; depth: number }> =
      await this.dataSource.query(
        `WITH RECURSIVE subtree AS (
           SELECT id, 0 AS depth FROM media_metadata WHERE id = ANY($1::uuid[])
           UNION ALL
           SELECT m.id, s.depth + 1
           FROM media_metadata m JOIN subtree s ON m.input_media_id = s.id
         )
         SELECT id, MAX(depth) AS depth FROM subtree
         GROUP BY id ORDER BY MAX(depth) DESC`,
        [rootIds],
      );

    let deleted = 0;
    for (const row of subtree) {
      try {
        await this.markRolledBack(row.id);
        deleted++;
      } catch (err) {
        // Rollback never hard-deletes media rows anymore, so a failure here
        // means the row vanished some other way (e.g. the user-removal
        // hard-delete sweep) or a transient DB error — skip and continue.
        this.logger.warn(
          `deleteByStateTransitionId: markRolledBack(${row.id}) failed: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `deleteByStateTransitionId: rolled back ${deleted} rows for stid="${stateTransitionId}"`,
    );
    return { deleted };
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
