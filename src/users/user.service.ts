import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { validate as isUuid } from 'uuid';
import { UserEntity } from './user.entity';
import { InteractionRow } from './interactions-csv';
import { CacheService } from '../interfaces/redis/cache';
import { CACHE_KEYS, CACHE_TTL } from '../interfaces/redis/cache.dto';
import { ScoreService } from '../literacy/score/score.service';
import { MediaBucketService } from '../interfaces/media-bucket/outbound/outbound.service';
import {
  User,
  FindUserOptions,
  UpdateUserOptions,
  CreateUserOptions,
  validateFindUserOptions,
  validateUpdateUserOptions,
  validateCreateUserOptions,
  partitionUserIdentifiers,
  LiteracyTestScores,
  SnapshotTestScore,
  TestSnapshotPoint,
} from './user.dto';

// ─── Snapshot scoring (NIPUN grades 2/3 + MPL-B) ─────────────────────────────

// A student's FIRST attempt at one question. Only first attempts count toward
// tests: once the child has seen the explanation for their tap, any repeat of
// that question is invalidated for testing.
interface FirstAttempt {
  at: Date;
  correct: boolean;
  question_id: string;
  // The question's level = its passage's media_details.level (the generation
  // pipeline's word-count level), NOT literacy_lesson_states.level (the
  // lesson cap, which can diverge on nearest-level passage fallback).
  level: number | null;
  question_type: string | null;
}

// All tests pass on score STRICTLY greater than 0.5.
const TEST_PASS_THRESHOLD = 0.5;

const NIPUN_QUESTION_COUNT = 4;
// NIPUN reading proxies use the retrieve subconstructs only.
const NIPUN_R1_TYPES = ['R1.1', 'R1.2', 'R1.3'];
const NIPUN_G2_LEVELS = [10];
const NIPUN_G3_LEVELS = [11, 12];

// MPL-B selection. Level-13 questions are excluded from every test (and from
// lessons) by construction — only levels 11/12 qualify here.
const MPL_B_LEVELS = [11, 12];
const MPL_B_QUESTION_COUNT = 20;
const MPL_B_MIN_DISTINCT_TYPES = 4;
const MPL_B_BATCHES: Array<{ types: string[]; required: number }> = [
  { types: ['R1.1', 'R1.2', 'R1.3'], required: 5 },
  { types: ['R2.1', 'R2.2', 'R2.3'], required: 5 },
  { types: ['R3.1', 'R3.2'], required: 1 },
];

// NIPUN grade 2/3 snapshot: the most recent `count` first attempts from the
// (already level/type-filtered) pool. Null = insufficient data.
function nipunSnapshot(
  pool: FirstAttempt[],
  count: number,
): { score: number; passed: boolean } | null {
  if (pool.length < count) return null;
  const selected = pool.slice(-count);
  const score = selected.filter((a) => a.correct).length / count;
  return { score, passed: score > TEST_PASS_THRESHOLD };
}

// MPL-B snapshot over a pool of level-11/12 first attempts (chronological).
// Four filters, walking most-recent-first; one question may satisfy both
// filter two and filter three. Null = insufficient data at any filter.
function mplBSnapshot(
  pool: FirstAttempt[],
): { score: number; passed: boolean } | null {
  // Filter one: fewer than 20 level-11/12 first attempts → no result.
  if (pool.length < MPL_B_QUESTION_COUNT) return null;
  const recent = [...pool].reverse();
  const selected = new Set<FirstAttempt>();

  // Filter two: most recent representative of each question type until four
  // distinct types are covered; three or fewer distinct types → no result.
  const seenTypes = new Set<string>();
  for (const attempt of recent) {
    if (seenTypes.size >= MPL_B_MIN_DISTINCT_TYPES) break;
    if (attempt.question_type && !seenTypes.has(attempt.question_type)) {
      seenTypes.add(attempt.question_type);
      selected.add(attempt);
    }
  }
  if (seenTypes.size < MPL_B_MIN_DISTINCT_TYPES) return null;

  // Filter three: most recent representatives per batch — R1.x ×5, R2.x ×5,
  // R3.x ×1 (filter-two picks count toward their batch).
  for (const batch of MPL_B_BATCHES) {
    let have = [...selected].filter(
      (a) => a.question_type && batch.types.includes(a.question_type),
    ).length;
    for (const attempt of recent) {
      if (have >= batch.required) break;
      if (
        !selected.has(attempt) &&
        attempt.question_type &&
        batch.types.includes(attempt.question_type)
      ) {
        selected.add(attempt);
        have++;
      }
    }
    if (have < batch.required) return null;
  }

  // Filter four: top up with the most recent remaining attempts to 20
  // (guaranteed reachable — the pool holds at least 20).
  for (const attempt of recent) {
    if (selected.size >= MPL_B_QUESTION_COUNT) break;
    selected.add(attempt);
  }

  const score =
    [...selected].filter((a) => a.correct).length / MPL_B_QUESTION_COUNT;
  return { score, passed: score > TEST_PASS_THRESHOLD };
}

// history[] = the snapshot algorithm replayed over every chronological prefix
// of the pool (insufficient-data prefixes skipped); latest = final entry.
function snapshotSeries(
  pool: FirstAttempt[],
  snapshot: (
    prefix: FirstAttempt[],
  ) => { score: number; passed: boolean } | null,
): SnapshotTestScore {
  const history: TestSnapshotPoint[] = [];
  for (let i = 0; i < pool.length; i++) {
    const result = snapshot(pool.slice(0, i + 1));
    if (result) {
      history.push({
        at: pool[i].at,
        score: result.score,
        passed: result.passed,
      });
    }
  }
  if (history.length === 0) {
    return { status: 'insufficient_data', attempts_available: pool.length };
  }
  return {
    status: 'ok',
    attempts_available: pool.length,
    latest: history[history.length - 1],
    history,
  };
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  /**
   * One keyset page of the interactions CSV export (oldest first). Inline
   * raw-SQL read; re-derives rolled_back = false on the transcript join per
   * the repo conventions. `to` is the caller-clamped upper bound; `cursor`
   * is the (created_at, id) of the last row already emitted.
   */
  async findInteractionsPage(options: {
    from: Date | null;
    to: Date;
    cursor: { created_at: Date; id: string } | null;
    limit: number;
  }): Promise<InteractionRow[]> {
    const { from, to, cursor, limit } = options;
    return await this.dataSource.query(
      `SELECT l.id AS lesson_state_id,
              l.created_at,
              to_char(l.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS timestamp_ist,
              u.name AS student_name,
              u.external_id AS phone,
              r.name AS referred_by_name,
              r.external_id AS referred_by_phone,
              l.level,
              CASE WHEN l.passage_id IS NULL THEN 'word' ELSE 'passage' END AS lesson_type,
              l.word AS content,
              l.answer AS correct_answer,
              l.answer_correct,
              t.sarvam AS sarvam_transcript,
              t.azure AS azure_transcript,
              t.reverie AS reverie_transcript,
              (um.media_details->>'duration_ms')::int AS audio_duration_ms,
              sc.score_change,
              sc.letters_touched,
              prev.final_state AS starting_state,
              l.snapshot->>'value' AS final_state,
              l.snapshot->'context'->>'stateTransitionId' AS state_transition_id,
              l.passage_id,
              l.user_message_id
       FROM literacy_lesson_states l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN users r ON r.id = u.referrer_user_id
       -- The turn's voice note (user_message_id IS its media row). No
       -- rolled_back filter: the child's recording length is factual
       -- history. duration_ms is container-parsed at ingest
       -- (audio-duration.utils.ts); flow taps have no audio row → NULL.
       LEFT JOIN media_metadata um ON um.id = l.user_message_id
       -- The snapshot stores the post-turn state, so this turn's starting
       -- state is the previous turn's final state ((user_id, created_at)
       -- index walk).
       LEFT JOIN LATERAL (
         SELECT p.snapshot->>'value' AS final_state
         FROM literacy_lesson_states p
         WHERE p.user_id = l.user_id
           AND (p.created_at, p.id) < (l.created_at, l.id)
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT 1
       ) prev ON true
       -- STT transcripts of the child's voice note, pivoted per engine.
       LEFT JOIN LATERAL (
         SELECT MAX(m.text) FILTER (WHERE m.source = 'sarvam') AS sarvam,
                MAX(m.text) FILTER (WHERE m.source = 'azure') AS azure,
                MAX(m.text) FILTER (WHERE m.source = 'reverie') AS reverie
         FROM media_metadata m
         WHERE m.input_media_id = l.user_message_id
           AND m.source IN ('sarvam', 'azure', 'reverie')
           AND m.rolled_back = false
       ) t ON true
       LEFT JOIN LATERAL (
         SELECT SUM(s.score) AS score_change, COUNT(*) AS letters_touched
         FROM scores s
         WHERE s.user_message_id = l.user_message_id AND s.user_id = l.user_id
       ) sc ON true
       WHERE l.created_at <= $1
         AND ($2::timestamptz IS NULL OR l.created_at >= $2)
         AND ($3::timestamptz IS NULL OR (l.created_at, l.id) > ($3, $4::uuid))
       ORDER BY l.created_at, l.id
       LIMIT $5`,
      [to, from, cursor?.created_at ?? null, cursor?.id ?? null, limit],
    );
  }

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly dataSource: DataSource,
    private readonly cacheService: CacheService,
    private readonly scoreService: ScoreService,
    private readonly mediaBucket: MediaBucketService,
  ) {}

  // Resolves a user by either a uuid or an E.164 external_id. Throws
  // BadRequestException on a string that is neither a valid uuid nor a valid
  // E.164 phone (delegated to find() for the external_id path). Returns null
  // on a well-shaped identifier that has no matching row.
  async findByIdOrExternalId(input: string): Promise<User | null> {
    return this.find(isUuid(input) ? { id: input } : { external_id: input });
  }

  // See partitionUserIdentifiers in user.dto.ts. Exposed here as a method so
  // callers with an injected UserService don't need a separate import.
  partitionIdentifiers(inputs: string[]): {
    ids: string[];
    externalIds: string[];
    canonical: string[];
  } {
    return partitionUserIdentifiers(inputs);
  }

  async find(options: FindUserOptions): Promise<User | null> {
    const validated = validateFindUserOptions(options);

    const cacheKey = validated.id
      ? CACHE_KEYS.userById(validated.id)
      : CACHE_KEYS.userByExternalId(validated.external_id!);

    const cached = await this.cacheService.get<User>(cacheKey);
    if (cached) return cached;

    const user = validated.id
      ? await this.userRepo.findOneBy({ id: validated.id })
      : await this.userRepo.findOneBy({ external_id: validated.external_id! });

    if (user) {
      await Promise.all([
        this.cacheService.set(
          CACHE_KEYS.userById(user.id),
          user,
          CACHE_TTL.USER,
        ),
        this.cacheService.set(
          CACHE_KEYS.userByExternalId(user.external_id),
          user,
          CACHE_TTL.USER,
        ),
      ]);
    }
    return user ?? null;
  }

  async update(options: UpdateUserOptions): Promise<User | null> {
    const validated = validateUpdateUserOptions(options);

    // Build update payload
    const updateFields: Partial<UserEntity> = {};

    if (validated.new_external_id !== undefined) {
      updateFields.external_id = validated.new_external_id;
    }

    if (validated.new_name !== undefined) {
      updateFields.name = validated.new_name;
    }

    if (validated.new_referrer_user_id !== undefined) {
      updateFields.referrer_user_id = validated.new_referrer_user_id;
    } else if (validated.new_referrer_external_id !== undefined) {
      // Resolve referrer by external_id — needs raw SQL subquery
      const referrerRows = await this.userRepo.findOneBy({
        external_id: validated.new_referrer_external_id,
      });
      updateFields.referrer_user_id = referrerRows?.id ?? null;
    }

    // Find the user first
    const where = validated.id
      ? { id: validated.id }
      : { external_id: validated.external_id! };

    const existingUser = await this.userRepo.findOneBy(where);
    if (!existingUser) return null;

    // Apply updates and save
    Object.assign(existingUser, updateFields);
    const updatedUser = await this.userRepo.save(existingUser);

    // Cycle check if referrer was set (raw SQL — recursive CTE)
    const referrerWasSet =
      validated.new_referrer_user_id !== undefined ||
      validated.new_referrer_external_id !== undefined;
    if (referrerWasSet && updatedUser.referrer_user_id) {
      const cycleRows: unknown[] = await this.dataSource.query(
        `WITH RECURSIVE chain AS (
          SELECT id, referrer_user_id FROM users WHERE id = $1
          UNION ALL
          SELECT u.id, u.referrer_user_id FROM users u
          JOIN chain c ON u.id = c.referrer_user_id
          WHERE c.referrer_user_id IS NOT NULL
        )
        SELECT 1 FROM chain WHERE id = $2`,
        [updatedUser.referrer_user_id, updatedUser.id],
      );

      if (cycleRows.length > 0) {
        // Roll back by removing the referrer
        updatedUser.referrer_user_id = null;
        await this.userRepo.save(updatedUser);
        throw new BadRequestException('update() would create a referral cycle');
      }
    }

    // Invalidate and repopulate cache
    const keysToDelete = [
      CACHE_KEYS.userById(updatedUser.id),
      CACHE_KEYS.userByExternalId(updatedUser.external_id),
    ];
    if (
      validated.new_external_id !== undefined &&
      validated.external_id !== undefined
    ) {
      keysToDelete.push(CACHE_KEYS.userByExternalId(validated.external_id));
    }
    await this.cacheService.del(keysToDelete);

    await Promise.all([
      this.cacheService.set(
        CACHE_KEYS.userById(updatedUser.id),
        updatedUser,
        CACHE_TTL.USER,
      ),
      this.cacheService.set(
        CACHE_KEYS.userByExternalId(updatedUser.external_id),
        updatedUser,
        CACHE_TTL.USER,
      ),
    ]);

    return updatedUser;
  }

  async create(options: CreateUserOptions): Promise<User> {
    const validated = validateCreateUserOptions(options);

    let user: UserEntity;

    if (validated.referrer_user_id) {
      user = this.userRepo.create({
        external_id: validated.external_id,
        name: validated.name ?? null,
        referrer_user_id: validated.referrer_user_id,
      });
      user = await this.userRepo.save(user);

      // Cycle check (raw SQL — recursive CTE)
      if (user.referrer_user_id) {
        const cycleRows: unknown[] = await this.dataSource.query(
          `WITH RECURSIVE chain AS (
            SELECT id, referrer_user_id FROM users WHERE id = $1
            UNION ALL
            SELECT u.id, u.referrer_user_id FROM users u
            JOIN chain c ON u.id = c.referrer_user_id
            WHERE c.referrer_user_id IS NOT NULL
          )
          SELECT 1 FROM chain WHERE id = $2`,
          [user.referrer_user_id, user.id],
        );
        if (cycleRows.length > 0) {
          await this.userRepo.remove(user);
          throw new BadRequestException(
            'create() would create a referral cycle',
          );
        }
      }

      await this.scoreService.createSeedScores(user.id);
      await this.populateUserCache(user);
      return user;
    } else if (validated.referrer_external_id) {
      // INSERT...SELECT with referrer lookup — raw SQL (complex query #5)
      const rows: UserEntity[] = await this.dataSource.query(
        `INSERT INTO users (external_id, name, referrer_user_id)
               SELECT $1, $2, id FROM users WHERE external_id = $3
               RETURNING *`,
        [
          validated.external_id,
          validated.name ?? null,
          validated.referrer_external_id,
        ],
      );

      if (rows.length === 0) {
        // Referrer not found — insert without referrer
        user = this.userRepo.create({
          external_id: validated.external_id,
          name: validated.name ?? null,
        });
        user = await this.userRepo.save(user);
        await this.scoreService.createSeedScores(user.id);
        await this.populateUserCache(user);
        return user;
      }
      user = rows[0];

      // Cycle check (raw SQL — recursive CTE)
      if (user.referrer_user_id) {
        const cycleRows: unknown[] = await this.dataSource.query(
          `WITH RECURSIVE chain AS (
            SELECT id, referrer_user_id FROM users WHERE id = $1
            UNION ALL
            SELECT u.id, u.referrer_user_id FROM users u
            JOIN chain c ON u.id = c.referrer_user_id
            WHERE c.referrer_user_id IS NOT NULL
          )
          SELECT 1 FROM chain WHERE id = $2`,
          [user.referrer_user_id, user.id],
        );
        if (cycleRows.length > 0) {
          await this.dataSource.query('DELETE FROM users WHERE id = $1', [
            user.id,
          ]);
          throw new BadRequestException(
            'create() would create a referral cycle',
          );
        }
      }

      await this.scoreService.createSeedScores(user.id);
      await this.populateUserCache(user);
      return user;
    } else {
      user = this.userRepo.create({
        external_id: validated.external_id,
        name: validated.name ?? null,
      });
    }

    user = await this.userRepo.save(user);
    await this.scoreService.createSeedScores(user.id);
    await this.populateUserCache(user);
    return user;
  }

  // Per-user atomic delete. Each user runs in its own transaction so one
  // failure does not block the rest of the batch. Errors are surfaced as
  // `failed` entries, never swallowed silently.
  async delete(input: string | string[]): Promise<{
    deleted: string[];
    failed: { input: string; reason: string }[];
  }> {
    const inputs = Array.isArray(input) ? input : [input];
    const deleted: string[] = [];
    const failed: { input: string; reason: string }[] = [];

    if (inputs.length === 0) return { deleted, failed };

    const resolvedRows: { id: string; external_id: string }[] =
      await this.dataSource.query(
        `SELECT id, external_id FROM users
         WHERE id::text = ANY($1) OR external_id = ANY($1)`,
        [inputs],
      );

    const resolvedById = new Map<string, { id: string; external_id: string }>();
    const resolvedByExternalId = new Map<
      string,
      { id: string; external_id: string }
    >();
    for (const row of resolvedRows) {
      resolvedById.set(row.id, row);
      resolvedByExternalId.set(row.external_id, row);
    }

    const seenIds = new Set<string>();
    const toProcess: { input: string; id: string; external_id: string }[] = [];
    for (const raw of inputs) {
      const row = resolvedById.get(raw) ?? resolvedByExternalId.get(raw);
      if (!row) {
        failed.push({ input: raw, reason: 'user not found' });
        continue;
      }
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      toProcess.push({ input: raw, id: row.id, external_id: row.external_id });
    }

    for (const target of toProcess) {
      let s3Keys: string[] = [];
      let nulledReferrers: { id: string; external_id: string }[] = [];

      try {
        await this.dataSource.transaction(async (manager) => {
          const mediaRows: { s3_key: string }[] = await manager.query(
            `SELECT s3_key FROM media_metadata
             WHERE user_id = $1 AND s3_key IS NOT NULL`,
            [target.id],
          );
          s3Keys = mediaRows.map((r) => r.s3_key);

          // Invalidate this user's cache as late as possible before writes.
          // Throwing here aborts the txn: if Redis is unreachable we cannot
          // guarantee the post-commit del either, so we refuse the write.
          await this.cacheService.del(
            [
              CACHE_KEYS.userById(target.id),
              CACHE_KEYS.userByExternalId(target.external_id),
            ],
            { throwOnError: true },
          );

          nulledReferrers = await manager.query(
            `UPDATE users SET referrer_user_id = NULL
             WHERE referrer_user_id = $1
             RETURNING id, external_id`,
            [target.id],
          );

          await manager.query(`DELETE FROM scores WHERE user_id = $1`, [
            target.id,
          ]);
          await manager.query(
            `DELETE FROM literacy_lesson_states WHERE user_id = $1`,
            [target.id],
          );
          // Invariant: any media_metadata row referencing one of this user's
          // media rows via input_media_id is itself owned by this user. If a
          // future code path violates that, this DELETE will FK-error and
          // this list must be extended (e.g. with a recursive pre-delete).
          await manager.query(`DELETE FROM media_metadata WHERE user_id = $1`, [
            target.id,
          ]);

          // Convention deviation: scores / literacy_lesson_states /
          // media_metadata writes happen here as raw SQL rather than through
          // their entity services. Done to keep one transaction per user
          // atomic without opening the UserService <-> MediaMetaDataService
          // module cycle.

          const userDelete: { id: string }[] = await manager.query(
            `DELETE FROM users WHERE id = $1 RETURNING id`,
            [target.id],
          );
          if (userDelete.length === 0) {
            throw new NotFoundException(
              `user ${target.id} vanished mid-transaction`,
            );
          }
        });
      } catch (err) {
        failed.push({ input: target.input, reason: (err as Error).message });
        continue;
      }

      deleted.push(target.input);

      // Best-effort post-commit cleanup. Failures are warn-logged, not
      // rolled back: the DB is the source of truth.
      for (const key of s3Keys) {
        try {
          await this.mediaBucket.delete(key);
        } catch (err) {
          this.logger.warn(
            `S3 delete failed for key ${key} during user ${target.id} delete: ${(err as Error).message}`,
          );
        }
      }

      // Second cache del closes the repopulate race: any reader between the
      // pre-write del and txn commit could have re-filled the cache.
      try {
        await this.cacheService.del([
          CACHE_KEYS.userById(target.id),
          CACHE_KEYS.userByExternalId(target.external_id),
        ]);
      } catch (err) {
        this.logger.warn(
          `Post-commit cache del failed for user ${target.id}: ${(err as Error).message}`,
        );
      }

      for (const ref of nulledReferrers) {
        try {
          await this.cacheService.del([
            CACHE_KEYS.userById(ref.id),
            CACHE_KEYS.userByExternalId(ref.external_id),
          ]);
        } catch (err) {
          this.logger.warn(
            `Referrer cache del failed for user ${ref.id}: ${(err as Error).message}`,
          );
        }
      }
    }

    return { deleted, failed };
  }

  /**
   * Digital-proxy literacy test scores (NIPUN grades 2/3 + MPL-B). Returns
   * null when the user does not exist; per-test status 'insufficient_data'
   * when there is not enough answer history yet.
   *
   * All three are snapshot tests over comprehension answers (the
   * comprehension query below — the tapped option is joined to its question
   * and the question's passage). Only a student's FIRST attempt at each question
   * counts: after seeing the explanation, repeats are invalidated. The
   * question's level is the passage's media_details.level (word-count level);
   * level-13 questions never qualify.
   */
  async getLiteracyTestScores(
    input: string,
  ): Promise<LiteracyTestScores | null> {
    const user = await this.findByIdOrExternalId(input);
    if (!user) return null;

    interface ComprehensionRow {
      created_at: Date;
      answer_correct: boolean;
      question_id: string;
      question_type: string | null;
      level: number | null;
    }
    const answers: ComprehensionRow[] = await this.dataSource.query(
      `SELECT s.created_at, s.answer_correct,
              q.id AS question_id,
              q.media_details->>'question_type' AS question_type,
              (p.media_details->>'level')::int AS level
       FROM literacy_lesson_states s
       -- Deliberately NO rolled_back filter on these joins (2026-08): a
       -- retroactively quality-culled passage must not erase the student's
       -- already-earned comprehension history (NIPUN grades 2/3, MPL-B).
       JOIN media_metadata o ON o.id::text = s.answer
       JOIN media_metadata q ON q.id = o.input_media_id
       JOIN media_metadata p ON p.id = q.input_media_id
       WHERE s.user_id = $1
         AND s.answer_correct IS NOT NULL
         AND (s.snapshot->'context'->>'stateTransitionId')
           LIKE '%-comprehension-complete'
       ORDER BY s.created_at ASC`,
      [user.id],
    );

    // Dedup to first attempts, in chronological order.
    const seenQuestions = new Set<string>();
    const dedupedAttempts: FirstAttempt[] = [];
    for (const row of answers) {
      if (seenQuestions.has(row.question_id)) continue;
      seenQuestions.add(row.question_id);
      dedupedAttempts.push({
        at: row.created_at,
        correct: row.answer_correct === true,
        question_id: row.question_id,
        level: row.level,
        question_type: row.question_type,
      });
    }

    const nipunGrade2Pool = dedupedAttempts.filter(
      (a) =>
        a.level !== null &&
        NIPUN_G2_LEVELS.includes(a.level) &&
        a.question_type !== null &&
        NIPUN_R1_TYPES.includes(a.question_type),
    );
    const nipunGrade3Pool = dedupedAttempts.filter(
      (a) =>
        a.level !== null &&
        NIPUN_G3_LEVELS.includes(a.level) &&
        a.question_type !== null &&
        NIPUN_R1_TYPES.includes(a.question_type),
    );
    const mplBPool = dedupedAttempts.filter(
      (a) => a.level !== null && MPL_B_LEVELS.includes(a.level),
    );

    return {
      nipun_grade_2: snapshotSeries(nipunGrade2Pool, (prefix) =>
        nipunSnapshot(prefix, NIPUN_QUESTION_COUNT),
      ),
      nipun_grade_3: snapshotSeries(nipunGrade3Pool, (prefix) =>
        nipunSnapshot(prefix, NIPUN_QUESTION_COUNT),
      ),
      mpl_b: snapshotSeries(mplBPool, mplBSnapshot),
    };
  }

  private async populateUserCache(user: User): Promise<void> {
    await Promise.all([
      this.cacheService.set(CACHE_KEYS.userById(user.id), user, CACHE_TTL.USER),
      this.cacheService.set(
        CACHE_KEYS.userByExternalId(user.external_id),
        user,
        CACHE_TTL.USER,
      ),
    ]);
  }
}
