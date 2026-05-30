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
} from './user.dto';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

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
      const cycleRows = await this.dataSource.query(
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
        const cycleRows = await this.dataSource.query(
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
      const rows = await this.dataSource.query(
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
        const cycleRows = await this.dataSource.query(
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
  async delete(
    input: string | string[],
  ): Promise<{
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
          await manager.query(
            `DELETE FROM media_metadata WHERE user_id = $1`,
            [target.id],
          );

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
