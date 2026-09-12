import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { validate as isUuid, v4 as uuidv4 } from 'uuid';
import { UserEntity } from './user.entity';
import { InteractionRow } from './interactions-csv';
import { CacheService } from '../interfaces/redis/cache';
import { CACHE_KEYS, CACHE_TTL } from '../interfaces/redis/cache.dto';
import { ScoreService } from '../literacy/score/score.service';
import { MediaBucketService } from '../interfaces/media-bucket/outbound/outbound.service';
import { onboardingCutoff } from '../onboarding/onboarding.config';
import {
  User,
  FindUserOptions,
  UpdateUserOptions,
  CreateUserOptions,
  CreateStaffOptions,
  STAFF_ROLES,
  validateFindUserOptions,
  validateUpdateUserOptions,
  validateCreateUserOptions,
  partitionUserIdentifiers,
  LiteracyTestScores,
} from './user.dto';
import { computeLiteracyTestScores } from '../literacy/score/literacy-test-scores';

// StaffUserRow before the dashboard link is attached (the controller adds it).
export type StaffLookupRow = Omit<import('./user.dto').StaffUserRow, 'link'>;

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

  // `manager` runs the write inside the caller's transaction. In that mode
  // the cache is only evicted, never repopulated (a set before commit would
  // publish uncommitted columns), and the caller must evict again after
  // commit — invalidateCache() — to close the repopulate race.
  async update(
    options: UpdateUserOptions,
    manager?: EntityManager,
  ): Promise<User | null> {
    const validated = validateUpdateUserOptions(options);
    const repo = manager ? manager.getRepository(UserEntity) : this.userRepo;
    const db = manager ?? this.dataSource;

    // Build update payload
    const updateFields: Partial<UserEntity> = {};

    if (validated.new_external_id !== undefined) {
      updateFields.external_id = validated.new_external_id;
    }

    if (validated.new_name !== undefined) {
      updateFields.name = validated.new_name;
    }

    if (validated.new_birth_year !== undefined) {
      updateFields.birth_year = validated.new_birth_year;
    }

    if (validated.new_birth_month !== undefined) {
      updateFields.birth_month = validated.new_birth_month;
    }

    if (validated.new_recording_permissions_obtained_at !== undefined) {
      updateFields.recording_permissions_obtained_at =
        validated.new_recording_permissions_obtained_at;
    }

    if (validated.new_role !== undefined) {
      updateFields.role = validated.new_role;
    }
    if (validated.new_password_hash !== undefined) {
      updateFields.password_hash = validated.new_password_hash;
    }
    if (validated.new_geo_entity_id !== undefined) {
      updateFields.geo_entity_id = validated.new_geo_entity_id;
    }
    if (validated.new_role_title !== undefined) {
      updateFields.role_title = validated.new_role_title;
    }
    if (validated.new_staff_notes !== undefined) {
      updateFields.staff_notes = validated.new_staff_notes;
    }
    if (validated.deactivate) {
      updateFields.deleted_at = new Date();
    } else if (validated.reactivate) {
      updateFields.deleted_at = null;
    }

    if (validated.new_referrer_user_id !== undefined) {
      updateFields.referrer_user_id = validated.new_referrer_user_id;
    } else if (validated.new_referrer_external_id !== undefined) {
      // Resolve referrer by external_id — needs raw SQL subquery
      const referrerRows = await repo.findOneBy({
        external_id: validated.new_referrer_external_id,
      });
      updateFields.referrer_user_id = referrerRows?.id ?? null;
    }

    // Find the user first
    const where = validated.id
      ? { id: validated.id }
      : { external_id: validated.external_id! };

    const existingUser = await repo.findOneBy(where);
    if (!existingUser) return null;

    // Apply updates and save
    Object.assign(existingUser, updateFields);
    const updatedUser = await repo.save(existingUser);

    // Cycle check if referrer was set (raw SQL — recursive CTE)
    const referrerWasSet =
      validated.new_referrer_user_id !== undefined ||
      validated.new_referrer_external_id !== undefined;
    if (referrerWasSet && updatedUser.referrer_user_id) {
      const cycleRows: unknown[] = await db.query(
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
        await repo.save(updatedUser);
        throw new BadRequestException('update() would create a referral cycle');
      }
    }

    // Invalidate and (outside a transaction) repopulate cache
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

    if (!manager) {
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
    }

    return updatedUser;
  }

  // Evicts both cache keys for a user. Callers that wrote through
  // update(…, manager) call this after their transaction commits.
  async invalidateCache(user: {
    id: string;
    external_id: string;
  }): Promise<void> {
    await this.cacheService.del([
      CACHE_KEYS.userById(user.id),
      CACHE_KEYS.userByExternalId(user.external_id),
    ]);
  }

  // Parent-onboarding gate (src/onboarding). True for staff accounts, for
  // users created before ONBOARDING_CUTOFF (grandfathered), and once the
  // onboarding machine has written birth_year + recording permission. Pure:
  // reads the user object the caller holds, which may be a cached copy —
  // every onboarding write evicts the cache so the next find() is fresh.
  isOnboarded(user: User): boolean {
    if (user.role != null && user.role !== 'student') return true;
    if (new Date(user.created_at) < onboardingCutoff()) return true;
    return (
      user.birth_year != null && user.recording_permissions_obtained_at != null
    );
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

  // ─── Staff accounts (education officials) ─────────────────────────────

  // POST /users/staff-create. The caller has already normalised the phone and
  // checked the geo entity (422). One INSERT: the id is generated here so
  // avatar_seed can equal it without a second write. Throws
  // ConflictException when the phone belongs to any user, any role.
  async createStaff(options: CreateStaffOptions): Promise<User> {
    const existing = await this.userRepo.findOneBy({
      external_id: options.external_id,
    });
    if (existing) {
      throw new ConflictException(
        'A user with this phone number already exists',
      );
    }
    const id = uuidv4();
    const user = this.userRepo.create({
      id,
      external_id: options.external_id,
      name: options.name,
      role: 'education_official',
      geo_entity_id: options.geo_entity_id,
      role_title: options.role_title,
      staff_notes: options.staff_notes ?? null,
      avatar_seed: id,
    });
    const saved = await this.userRepo.save(user);
    await this.scoreService.createSeedScores(saved.id);
    await this.populateUserCache(saved);
    return saved;
  }

  // GET /users/lookup: staff-role accounts only, soft-deleted included.
  async lookupStaff(q: string, limit = 20): Promise<StaffLookupRow[]> {
    const trimmed = q.trim();
    if (trimmed.length === 0) return [];
    const digits = trimmed.replace(/\D/g, '');
    return await this.dataSource.query(
      `SELECT u.id, u.external_id, u.name, u.role, u.role_title, u.staff_notes,
              u.geo_entity_id, g.name AS geo_entity_name, g.type AS geo_entity_type,
              u.deleted_at
       FROM users u
       LEFT JOIN geo_entity g ON g.id = u.geo_entity_id
       WHERE u.role = ANY($1::text[])
         AND (u.name ILIKE '%' || $2 || '%'
              OR ($3 <> '' AND u.external_id LIKE '%' || $3 || '%'))
       ORDER BY u.deleted_at IS NOT NULL, u.name NULLS LAST, u.created_at DESC
       LIMIT $4`,
      [[...STAFF_ROLES], trimmed, digits, limit],
    );
  }

  // GET /users/:id: one staff-role account (soft-deleted included) with its
  // geo entity's name/type; null for any other role or unknown id.
  async getStaff(id: string): Promise<StaffLookupRow | null> {
    if (!isUuid(id)) return null;
    const rows: StaffLookupRow[] = await this.dataSource.query(
      `SELECT u.id, u.external_id, u.name, u.role, u.role_title, u.staff_notes,
              u.geo_entity_id, g.name AS geo_entity_name, g.type AS geo_entity_type,
              u.deleted_at
       FROM users u
       LEFT JOIN geo_entity g ON g.id = u.geo_entity_id
       WHERE u.id = $1 AND u.role = ANY($2::text[])`,
      [id, [...STAFF_ROLES]],
    );
    return rows[0] ?? null;
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

          // Everything else hanging off the user (media, transcripts,
          // scores, lesson + onboarding states, outbound audit rows) goes
          // via ON DELETE CASCADE — see CascadeUserDeletes migration and
          // foreign-keys.spec.ts.
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
    const scores = await computeLiteracyTestScores(
      (sql, params) => this.dataSource.query(sql, params),
      [user.id],
    );
    return scores.get(user.id) ?? null;
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
