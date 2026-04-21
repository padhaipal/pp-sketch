import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { UserEntity } from './user.entity';
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

const SEED_SCORES: { grapheme: string; score: number }[] = [
  { grapheme: 'ऋ', score: -99 },
  { grapheme: 'ा', score: -98.5 },
  { grapheme: 'ी', score: -98 },
  { grapheme: 'ु', score: -97.5 },
  { grapheme: 'े', score: -97 },
  { grapheme: 'ो', score: -96.5 },
  { grapheme: 'ै', score: -96 },
  { grapheme: 'ू', score: -95.5 },
  { grapheme: 'ौ', score: -95 },
  { grapheme: 'ि', score: -94.5 },
  { grapheme: 'ं', score: -94 },
  { grapheme: 'ृ', score: -93.5 },
  { grapheme: 'ञ', score: -200 },
  { grapheme: 'ण', score: -200 },
  { grapheme: 'अ', score: -100 },
  { grapheme: 'आ', score: -100 },
  { grapheme: 'इ', score: -100 },
  { grapheme: 'ई', score: -100 },
  { grapheme: 'उ', score: -100 },
  { grapheme: 'ऊ', score: -100 },
  { grapheme: 'ए', score: -100 },
  { grapheme: 'ऐ', score: -100 },
  { grapheme: 'ओ', score: -100 },
  { grapheme: 'औ', score: -100 },
  { grapheme: 'क', score: -100 },
  { grapheme: 'ख', score: -100 },
  { grapheme: 'ग', score: -100 },
  { grapheme: 'घ', score: -100 },
  { grapheme: 'च', score: -100 },
  { grapheme: 'छ', score: -100 },
  { grapheme: 'ज', score: -100 },
  { grapheme: 'झ', score: -100 },
  { grapheme: 'ट', score: -100 },
  { grapheme: 'ठ', score: -100 },
  { grapheme: 'ड', score: -100 },
  { grapheme: 'ढ', score: -100 },
  { grapheme: 'त', score: -100 },
  { grapheme: 'थ', score: -100 },
  { grapheme: 'द', score: -100 },
  { grapheme: 'ध', score: -100 },
  { grapheme: 'न', score: -100 },
  { grapheme: 'प', score: -100 },
  { grapheme: 'फ', score: -100 },
  { grapheme: 'ब', score: -100 },
  { grapheme: 'भ', score: -100 },
  { grapheme: 'म', score: -100 },
  { grapheme: 'य', score: -100 },
  { grapheme: 'र', score: -100 },
  { grapheme: 'ल', score: -100 },
  { grapheme: 'व', score: -100 },
  { grapheme: 'श', score: -100 },
  { grapheme: 'ष', score: -100 },
  { grapheme: 'स', score: -100 },
  { grapheme: 'ह', score: -100 },
];

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly dataSource: DataSource,
    private readonly cacheService: CacheService,
  ) {}

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
        const { BadRequestException } = await import('@nestjs/common');
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
          const { BadRequestException } = await import('@nestjs/common');
          throw new BadRequestException(
            'create() would create a referral cycle',
          );
        }
      }

      await this.createSeedScores(user.id);
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
        await this.createSeedScores(user.id);
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
          const { BadRequestException } = await import('@nestjs/common');
          throw new BadRequestException(
            'create() would create a referral cycle',
          );
        }
      }

      await this.createSeedScores(user.id);
      await this.populateUserCache(user);
      return user;
    } else {
      user = this.userRepo.create({
        external_id: validated.external_id,
        name: validated.name ?? null,
      });
    }

    user = await this.userRepo.save(user);
    await this.createSeedScores(user.id);
    await this.populateUserCache(user);
    return user;
  }

  private async createSeedScores(userId: string): Promise<void> {
    if (SEED_SCORES.length === 0) return;

    const params: unknown[] = [userId];
    const selects: string[] = [];

    for (const { grapheme, score } of SEED_SCORES) {
      const gIdx = params.push(grapheme);
      const sIdx = params.push(score);
      selects.push(
        `SELECT $1::uuid, l.id, $${sIdx}::double precision FROM letters l WHERE l.grapheme = $${gIdx}`,
      );
    }

    const rows = await this.dataSource.query(
      `INSERT INTO scores (user_id, letter_id, score)
       ${selects.join('\n       UNION ALL\n       ')}`,
      params,
    );

    this.logger.log(`Seed scores: inserted ${rows.length} for user ${userId}`);
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
