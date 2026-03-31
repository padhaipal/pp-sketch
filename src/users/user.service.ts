import { Injectable, Logger } from '@nestjs/common';
import { pool } from '../interfaces/database/database';
import { CacheService } from '../interfaces/redis/cache';
import { CACHE_KEYS, CACHE_TTL } from '../interfaces/redis/cache.dto';
import {
  User,
  FindUserOptions,
  UpdateUserOptions,
  CreateUserOptions,
  validateFindUserOptions,
  validateUpdateUserOptions,
  validateCreateUserOptions,
} from './user.dto';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(private readonly cacheService: CacheService) {}

  async find(options: FindUserOptions): Promise<User | null> {
    const validated = validateFindUserOptions(options);

    const cacheKey = validated.id
      ? CACHE_KEYS.userById(validated.id)
      : CACHE_KEYS.userByExternalId(validated.external_id!);

    const cached = await this.cacheService.get<User>(cacheKey);
    if (cached) return cached;

    const { rows } = validated.id
      ? await pool.query<User>(
          'SELECT * FROM users WHERE id = $1',
          [validated.id],
        )
      : await pool.query<User>(
          'SELECT * FROM users WHERE external_id = $1',
          [validated.external_id],
        );

    const user = rows[0] ?? null;
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
    return user;
  }

  async update(options: UpdateUserOptions): Promise<User | null> {
    const validated = validateUpdateUserOptions(options);

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (validated.new_external_id !== undefined) {
      setClauses.push(`external_id = $${paramIdx++}`);
      params.push(validated.new_external_id);
    }

    if (validated.new_referrer_user_id !== undefined) {
      setClauses.push(`referrer_user_id = $${paramIdx++}`);
      params.push(validated.new_referrer_user_id);
    } else if (validated.new_referrer_external_id !== undefined) {
      setClauses.push(
        `referrer_user_id = (SELECT id FROM users WHERE external_id = $${paramIdx++})`,
      );
      params.push(validated.new_referrer_external_id);
    }

    const whereClause = validated.id
      ? `id = $${paramIdx++}`
      : `external_id = $${paramIdx++}`;
    params.push(validated.id ?? validated.external_id);

    const { rows } = await pool.query<User>(
      `UPDATE users SET ${setClauses.join(', ')} WHERE ${whereClause} RETURNING *`,
      params,
    );

    const updatedUser = rows[0] ?? null;
    if (!updatedUser) return null;

    // Cycle check if referrer was set
    const referrerWasSet =
      validated.new_referrer_user_id !== undefined ||
      validated.new_referrer_external_id !== undefined;
    if (referrerWasSet && updatedUser.referrer_user_id) {
      const { rows: cycleRows } = await pool.query(
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
        await pool.query(
          'UPDATE users SET referrer_user_id = NULL WHERE id = $1',
          [updatedUser.id],
        );
        const { BadRequestException } = await import('@nestjs/common');
        throw new BadRequestException(
          'update() would create a referral cycle',
        );
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
      keysToDelete.push(
        CACHE_KEYS.userByExternalId(validated.external_id),
      );
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

    let query: string;
    let params: unknown[];

    if (validated.referrer_user_id) {
      query = `INSERT INTO users (external_id, referrer_user_id)
               VALUES ($1, $2) RETURNING *`;
      params = [validated.external_id, validated.referrer_user_id];

      const { rows } = await pool.query<User>(query, params);
      const user = rows[0];

      // Cycle check
      if (user.referrer_user_id) {
        const { rows: cycleRows } = await pool.query(
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
          await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
          const { BadRequestException } = await import('@nestjs/common');
          throw new BadRequestException(
            'create() would create a referral cycle',
          );
        }
      }

      await this.populateUserCache(user);
      return user;
    } else if (validated.referrer_external_id) {
      query = `INSERT INTO users (external_id, referrer_user_id)
               SELECT $1, id FROM users WHERE external_id = $2
               RETURNING *`;
      params = [validated.external_id, validated.referrer_external_id];

      // If referrer not found, insert without referrer
      const { rows } = await pool.query<User>(query, params);
      if (rows.length === 0) {
        const fallback = await pool.query<User>(
          'INSERT INTO users (external_id) VALUES ($1) RETURNING *',
          [validated.external_id],
        );
        const user = fallback.rows[0];
        await this.populateUserCache(user);
        return user;
      }
      const user = rows[0];

      // Cycle check
      if (user.referrer_user_id) {
        const { rows: cycleRows } = await pool.query(
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
          await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
          const { BadRequestException } = await import('@nestjs/common');
          throw new BadRequestException(
            'create() would create a referral cycle',
          );
        }
      }

      await this.populateUserCache(user);
      return user;
    } else {
      query = 'INSERT INTO users (external_id) VALUES ($1) RETURNING *';
      params = [validated.external_id];
    }

    const { rows } = await pool.query<User>(query, params);
    const user = rows[0];
    await this.populateUserCache(user);
    return user;
  }

  private async populateUserCache(user: User): Promise<void> {
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
}
