import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CacheService } from '../interfaces/redis/cache';
import { CACHE_KEYS, CACHE_TTL } from '../interfaces/redis/cache.dto';
import { onboardingCutoff } from '../onboarding/onboarding.config';
import { INTERACTION_MEDIA_SQL, IS_TAP_SQL } from './active-time';
import {
  INTERACTION_STREAM_DELAY_S,
  INTERACTION_STREAM_LIMIT,
  INTERACTION_STREAM_POOL,
  toStreamRow,
  type InteractionSourceRow,
  type InteractionStreamResponse,
} from './interaction-stream';

const UUID_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

// The donor page's interaction stream (GET users/dashboard/interactions,
// interaction-stream.ts has the row shape). Every open donor page polls once
// a minute, so the answer is computed at most once per CACHE_TTL window and
// shared through pp-redis-cache: any number of visitors cost one query a
// minute. A concurrent miss shares the in-flight computation (per process).
// Turns are published only once INTERACTION_STREAM_DELAY_S old; with the
// cache on top a visitor sees them two to three minutes after they happened.
@Injectable()
export class InteractionStreamService {
  private readonly logger = new Logger(InteractionStreamService.name);
  private inflight: Promise<InteractionStreamResponse> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly cacheService: CacheService,
  ) {}

  async get(): Promise<InteractionStreamResponse> {
    const cached = await this.cacheService.get<InteractionStreamResponse>(
      CACHE_KEYS.interactionStream(),
    );
    if (cached) return cached;
    if (!this.inflight) {
      this.inflight = this.compute().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async compute(): Promise<InteractionStreamResponse> {
    const started = Date.now();
    const rows = await this.readRows();
    const response: InteractionStreamResponse = {
      computed_at: new Date().toISOString(),
      delay_s: INTERACTION_STREAM_DELAY_S,
      rows: rows.map(toStreamRow).filter((r) => r.answer_correct !== null),
    };
    await this.cacheService.set(
      CACHE_KEYS.interactionStream(),
      response,
      CACHE_TTL.INTERACTION_STREAM,
    );
    this.logger.log(
      `interaction-stream.computed rows=${response.rows.length} ms=${Date.now() - started}`,
    );
    return response;
  }

  // Students only (onboarded, not deleted, not load-test numbers), their
  // lesson turns after recording consent — no onboarding turns, nothing
  // rolled back, and only graded ones (marked correct or incorrect): the
  // newest INTERACTION_STREAM_POOL turns are read, the newest
  // INTERACTION_STREAM_LIMIT graded ones kept. Lesson columns follow GET users/:id/media: the first
  // (evaluation) lesson row per message, and the student's previous one for
  // the displayed answer.
  private readRows(): Promise<InteractionSourceRow[]> {
    const loadTestPrefix = process.env.LOAD_TEST_PHONE_PREFIX || null;
    return this.dataSource.query<InteractionSourceRow[]>(
      `/* interaction-stream:rows */
       WITH recent AS (
         SELECT mm.id, mm.user_id, mm.created_at, mm.media_type, mm.text,
                mm.media_details->>'duration_ms' AS duration_ms,
                u.name AS student_name
         FROM media_metadata mm
         JOIN users u ON u.id = mm.user_id
         WHERE ${INTERACTION_MEDIA_SQL('mm')}
           AND mm.rolled_back = false
           AND mm.created_at <= now() - make_interval(secs => $1)
           AND COALESCE(u.role, 'student') = 'student'
           AND u.deleted_at IS NULL
           AND (u.created_at < $2
                OR (u.birth_year IS NOT NULL
                    AND u.recording_permissions_obtained_at IS NOT NULL))
           AND (u.recording_permissions_obtained_at IS NULL
                OR mm.created_at > u.recording_permissions_obtained_at)
           AND ($3::text IS NULL OR u.external_id NOT LIKE $3::text || '%')
           AND NOT EXISTS (SELECT 1 FROM onboarding_states os
                           WHERE os.user_message_id = mm.id)
         ORDER BY mm.created_at DESC
         LIMIT $5
       )
       SELECT r.id, r.user_id, r.created_at, r.media_type, r.duration_ms,
              r.student_name,
              l.word AS lesson_word,
              l.answer_correct AS lesson_answer_correct,
              pl.word AS prev_word, pl.answer AS prev_answer,
              (pm.id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM media_metadata t
                 WHERE t.user_id = r.user_id
                   AND ${INTERACTION_MEDIA_SQL('t')} AND ${IS_TAP_SQL('t')}
                   AND t.created_at > pm.created_at
                   AND t.created_at < r.created_at)) AS tap_between,
              o.text AS tap_chosen,
              CASE WHEN o.id IS NULL THEN NULL
                   ELSE o.media_details->>'correct' = 'true' END
                AS tap_chosen_correct,
              (SELECT c.text FROM media_metadata c
               WHERE o.id IS NOT NULL
                 AND c.input_media_id = o.input_media_id
                 AND c.media_details->>'role' = 'option'
                 AND c.media_details->>'correct' = 'true'
               ORDER BY c.created_at
               LIMIT 1) AS tap_correct,
              (SELECT json_agg(json_build_object('source', tr.source,
                                                 'text', tr.text))
               FROM media_metadata tr
               WHERE r.media_type = 'audio'
                 AND tr.input_media_id = r.id
                 AND tr.media_type = 'text') AS transcripts
       FROM recent r
       LEFT JOIN LATERAL (
         SELECT ls.word, ls.answer_correct, ls.created_at
         FROM literacy_lesson_states ls
         WHERE ls.user_id = r.user_id AND ls.user_message_id = r.id
         ORDER BY ls.created_at ASC
         LIMIT 1
       ) l ON true
       LEFT JOIN LATERAL (
         SELECT ls.user_message_id
         FROM literacy_lesson_states ls
         WHERE ls.user_id = r.user_id AND ls.user_message_id <> r.id
           AND ls.created_at < COALESCE(l.created_at, r.created_at)
         ORDER BY ls.created_at DESC
         LIMIT 1
       ) p ON true
       LEFT JOIN LATERAL (
         SELECT ls.word, ls.answer
         FROM literacy_lesson_states ls
         WHERE ls.user_id = r.user_id
           AND ls.user_message_id = p.user_message_id
         ORDER BY ls.created_at ASC
         LIMIT 1
       ) pl ON true
       LEFT JOIN media_metadata pm ON pm.id = p.user_message_id
       LEFT JOIN media_metadata o
         ON o.id = (CASE WHEN r.media_type = 'text' AND r.text ~* '${UUID_PATTERN}'
                         THEN r.text::uuid END)
        AND o.media_details->>'role' = 'option'
       -- graded turns only: answer_correct (toStreamRow) is not null
       WHERE (CASE WHEN r.media_type = 'text'
                   THEN COALESCE(CASE WHEN o.id IS NULL THEN NULL
                                      ELSE o.media_details->>'correct' = 'true' END,
                                 l.answer_correct)
                   ELSE l.answer_correct END) IS NOT NULL
       ORDER BY r.created_at DESC
       LIMIT $4`,
      [
        INTERACTION_STREAM_DELAY_S,
        onboardingCutoff(),
        loadTestPrefix,
        INTERACTION_STREAM_LIMIT,
        INTERACTION_STREAM_POOL,
      ],
    );
  }
}
