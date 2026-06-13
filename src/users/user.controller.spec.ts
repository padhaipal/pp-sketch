process.env.LOG_PII_HMAC_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

// uuid is ESM-only — transitively imported via UserService.
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'gen-uuid'),
  validate: (s: unknown): boolean =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));

import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { Repository } from 'typeorm';
import { UserController } from './user.controller';
import type { UserEntity } from './user.entity';
import type { MediaMetaDataEntity } from '../media-meta-data/media-meta-data.entity';
import type { ScoreEntity } from '../literacy/score/score.entity';
import type { LiteracyLessonStateEntity } from '../literacy/literacy-lesson/literacy-lesson-state.entity';
import type { UserActivityService } from './user-activity.service';
import type { UserService } from './user.service';

type SimpleRepo = {
  findOneBy: jest.Mock;
  find: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
  createQueryBuilder: jest.Mock;
  manager: { query: jest.Mock };
};

function makeQB(
  rows: unknown[] | ((args: unknown) => unknown[]),
): Record<string, jest.Mock> {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    whereInIds: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    offset: jest.fn(),
    limit: jest.fn(),
    getRawMany: jest
      .fn()
      .mockImplementation(async () =>
        typeof rows === 'function' ? rows(undefined) : rows,
      ),
    getMany: jest
      .fn()
      .mockImplementation(async () =>
        typeof rows === 'function' ? rows(undefined) : rows,
      ),
  };
  for (const k of Object.keys(qb)) {
    if (!['getRawMany', 'getMany'].includes(k)) qb[k].mockReturnValue(qb);
  }
  return qb;
}

function makeRepo(opts: Partial<SimpleRepo> = {}): SimpleRepo {
  return {
    findOneBy: opts.findOneBy ?? jest.fn(),
    find: opts.find ?? jest.fn(),
    save: opts.save ?? jest.fn(),
    remove: opts.remove ?? jest.fn(),
    createQueryBuilder: opts.createQueryBuilder ?? jest.fn(),
    manager: opts.manager ?? { query: jest.fn() },
  };
}

function makeController(opts: {
  userRepo?: SimpleRepo;
  mediaRepo?: SimpleRepo;
  scoreRepo?: SimpleRepo;
  lessonStateRepo?: SimpleRepo;
  activitySvc?: Partial<UserActivityService>;
  userSvc?: Partial<UserService>;
}): UserController {
  return new UserController(
    (opts.userRepo ?? makeRepo()) as unknown as Repository<UserEntity>,
    (opts.mediaRepo ??
      makeRepo()) as unknown as Repository<MediaMetaDataEntity>,
    (opts.scoreRepo ?? makeRepo()) as unknown as Repository<ScoreEntity>,
    (opts.lessonStateRepo ??
      makeRepo()) as unknown as Repository<LiteracyLessonStateEntity>,
    (opts.activitySvc ?? {}) as UserActivityService,
    (opts.userSvc ?? { delete: jest.fn() }) as UserService,
  );
}

describe('UserController.activityTime', () => {
  it('delegates to UserActivityService.getActivityTime', async () => {
    const getActivityTime = jest.fn().mockResolvedValue({ results: [] });
    const ctrl = makeController({ activitySvc: { getActivityTime } });
    const body = { users: ['u1'], windows: [] } as never;

    await ctrl.activityTime(body);
    expect(getActivityTime).toHaveBeenCalledWith(body);
  });
});

describe('UserController.dashboard', () => {
  it('returns [] when no active users are found', async () => {
    const mediaRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(makeQB([])),
    });
    const ctrl = makeController({ mediaRepo });
    await expect(ctrl.dashboard()).resolves.toEqual([]);
  });

  it('clamps a negative offset to 0', async () => {
    const qb = makeQB([]);
    const mediaRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    });
    const ctrl = makeController({ mediaRepo });
    await ctrl.dashboard('-50');
    expect(qb.offset).toHaveBeenCalledWith(0);
  });

  it('clamps a non-numeric offset to 0', async () => {
    const qb = makeQB([]);
    const mediaRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    });
    const ctrl = makeController({ mediaRepo });
    await ctrl.dashboard('abc');
    expect(qb.offset).toHaveBeenCalledWith(0);
  });

  it('returns the merged dashboard row shape (users + referrers + activity)', async () => {
    const activeUsers = [
      { user_id: 'u1', last_active: new Date('2026-04-27T10:00:00Z') },
    ];
    const users = [
      {
        id: 'u1',
        name: 'Alice',
        external_id: '919999990001',
        referrer_user_id: 'ref-1',
      },
    ];
    const referrers = [
      { id: 'ref-1', name: 'Ref', external_id: '917777770003' },
    ];
    // 3 separate createQueryBuilder calls: active users (raw), users (typed), referrers (typed)
    const mediaQB = makeQB(activeUsers);
    const userQB1 = makeQB(users);
    const userQB2 = makeQB(referrers);
    const mediaRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(mediaQB),
    });
    const userRepo = makeRepo({
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(userQB1)
        .mockReturnValueOnce(userQB2),
    });
    const getActivityTime = jest.fn().mockResolvedValue({
      results: [
        {
          user_id: 'u1',
          external_id: '919999990001',
          windows: Array(7)
            .fill(null)
            .map((_, i) => ({ start: '', end: '', active_ms: i * 1000 })),
        },
      ],
    });
    const ctrl = makeController({
      userRepo,
      mediaRepo,
      activitySvc: { getActivityTime },
    });

    const out = await ctrl.dashboard();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'u1',
      name: 'Alice',
      external_id: '919999990001',
      referrer: { name: 'Ref', external_id: '917777770003' },
    });
    expect(out[0].activity).toHaveLength(7);
    expect(out[0].activity[2].active_ms).toBe(2000);
  });

  it('falls back to null referrer when the referrer fetch would be empty (no referrer ids)', async () => {
    const activeUsers = [{ user_id: 'u1', last_active: new Date() }];
    const users = [
      {
        id: 'u1',
        name: null,
        external_id: '919999990001',
        referrer_user_id: null,
      },
    ];
    const mediaQB = makeQB(activeUsers);
    const userQB1 = makeQB(users);
    const userRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(userQB1),
    });
    const mediaRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(mediaQB),
    });
    const getActivityTime = jest.fn().mockResolvedValue({
      results: [],
    });

    const ctrl = makeController({
      userRepo,
      mediaRepo,
      activitySvc: { getActivityTime },
    });
    const out = await ctrl.dashboard();
    expect(out[0].referrer).toBeNull();
    expect(out[0].name).toBeNull();
    // No activity result for this user → active_ms defaults to 0
    expect(out[0].activity.every((a) => a.active_ms === 0)).toBe(true);
  });
});

describe('UserController.userMetrics', () => {
  it('throws NotFoundException when the user does not exist', async () => {
    const userRepo = makeRepo({ findOneBy: jest.fn().mockResolvedValue(null) });
    const ctrl = makeController({ userRepo });
    await expect(ctrl.userMetrics('u1')).rejects.toThrow(NotFoundException);
  });

  it('builds one IST-day window per day from signup through today and aggregates', async () => {
    // Signed up 3 IST-days ago → 4 windows (days 0..3 inclusive).
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'u1',
        created_at: threeDaysAgo,
      }),
    });
    // Two days over the 5-min (300_000 ms) threshold, one just under, one idle.
    const getActivityTime = jest.fn().mockResolvedValue({
      results: [
        {
          user_id: 'u1',
          windows: [
            { active_ms: 600_000 },
            { active_ms: 300_000 }, // exactly 5 min → NOT counted (strict >)
            { active_ms: 400_000 },
            { active_ms: 0 },
          ],
        },
      ],
    });
    const ctrl = makeController({ userRepo, activitySvc: { getActivityTime } });

    const out = await ctrl.userMetrics('u1');

    // 4 windows requested for [signup .. today] inclusive.
    const [{ users, windows }] = getActivityTime.mock.calls[0];
    expect(users).toEqual(['u1']);
    expect(windows).toHaveLength(4);
    expect(out).toEqual({
      days_since_signup: 3,
      total_active_ms: 1_300_000,
      days_over_five_min: 2,
    });
  });

  it('defaults to zeroes when the user has no activity results', async () => {
    const userRepo = makeRepo({
      findOneBy: jest
        .fn()
        .mockResolvedValue({ id: 'u1', created_at: new Date() }),
    });
    const getActivityTime = jest.fn().mockResolvedValue({ results: [] });
    const ctrl = makeController({ userRepo, activitySvc: { getActivityTime } });

    const out = await ctrl.userMetrics('u1');
    expect(out).toEqual({
      days_since_signup: 0,
      total_active_ms: 0,
      days_over_five_min: 0,
    });
  });
});

describe('UserController.userMedia', () => {
  it('throws NotFoundException when the user does not exist', async () => {
    const userRepo = makeRepo({ findOneBy: jest.fn().mockResolvedValue(null) });
    const ctrl = makeController({ userRepo });
    await expect(ctrl.userMedia('u1')).rejects.toThrow(NotFoundException);
  });

  it('returns user info with empty media when the user has no whatsapp audio', async () => {
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'u1',
        name: 'Alice',
        external_id: '919999990001',
      }),
    });
    const mediaRepo = makeRepo({ find: jest.fn().mockResolvedValue([]) });
    const ctrl = makeController({ userRepo, mediaRepo });

    const out = await ctrl.userMedia('u1');
    expect(out).toEqual({
      user: { name: 'Alice', phone: '919999990001' },
      media: [],
    });
  });

  it('happy path: merges transcripts + lessons + score changes; word-boundary answer logic', async () => {
    const user = { id: 'u1', name: 'A', external_id: '919999990001' };
    // Media ordered created_at DESC (controller-supplied via repo.find).
    const media = [
      {
        id: 'm3',
        created_at: new Date('2026-04-27T12:00:00Z'),
        s3_key: 's3-3',
      },
      { id: 'm2', created_at: new Date('2026-04-27T11:00:00Z'), s3_key: null },
      {
        id: 'm1',
        created_at: new Date('2026-04-27T10:00:00Z'),
        s3_key: 's3-1',
      },
    ];
    const transcripts = [
      {
        id: 't1',
        input_media_id: 'm1',
        text: 'hi',
        source: 'whisper',
        created_at: new Date(),
      },
      {
        id: 't-orphan',
        input_media_id: null, // skip path: continue
        text: 'orphan',
        source: 'whisper',
        created_at: new Date(),
      },
    ];
    const lessonStates = [
      {
        user_message_id: 'm1',
        word: 'mama',
        answer: 'ma',
        answer_correct: true,
        snapshot: { context: { stateTransitionId: 'lesson-A-B-C' } },
      },
      // Two states with same user_message_id — second is the "start fresh" dup and should be ignored.
      {
        user_message_id: 'm2',
        word: 'mama',
        answer: 'ma',
        answer_correct: true,
        snapshot: {},
      },
      {
        user_message_id: 'm2',
        word: 'mama2',
        answer: 'next',
        answer_correct: true,
        snapshot: {},
      },
      {
        user_message_id: 'm3',
        word: 'papa',
        answer: 'pa',
        answer_correct: false,
        snapshot: { context: { stateTransitionId: 'short' } }, // <3 parts → no transition split
      },
    ];
    const scoreRows = [
      {
        user_message_id: 'm1',
        grapheme: 'क',
        score: 2,
        prev_score: 0,
      },
      {
        user_message_id: 'm3',
        grapheme: 'क',
        score: 3,
        prev_score: 2,
      },
    ];

    const userRepo = makeRepo({ findOneBy: jest.fn().mockResolvedValue(user) });
    const mediaRepo = makeRepo({
      find: jest.fn().mockResolvedValue(media),
      createQueryBuilder: jest.fn().mockReturnValue(makeQB(transcripts)),
    });
    const lessonStateRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(makeQB(lessonStates)),
    });
    const scoreRepo = makeRepo({
      manager: { query: jest.fn().mockResolvedValue(scoreRows) },
    });

    const ctrl = makeController({
      userRepo,
      mediaRepo,
      scoreRepo,
      lessonStateRepo,
    });

    const out = await ctrl.userMedia('u1');

    expect(out.user).toEqual({ name: 'A', phone: '919999990001' });
    expect(out.media).toHaveLength(3);
    // m1 has audio + transcript + lesson + score; starting/final states from "lesson-A-B-C"
    const m1 = out.media.find((m) => m.id === 'm1')!;
    expect(m1.has_audio).toBe(true);
    // transitionId 'lesson-A-B-C' → parts = ['lesson','A','B','C'] → parts[1]=A, parts[2]=B
    expect(m1.starting_state).toBe('A');
    expect(m1.final_state).toBe('B');
    expect(m1.answer).toBe('mama'); // first row → uses lesson.word
    expect(m1.score_changes).toEqual([
      { grapheme: 'क', score: 2, prev_score: 0 },
    ]);
    // m2 keeps the FIRST lesson row only (word='mama', answer='ma')
    const m2 = out.media.find((m) => m.id === 'm2')!;
    expect(m2.word).toBe('mama');
    // m2 same word as m1 → uses prevAnswer ('ma')
    expect(m2.answer).toBe('ma');
    // m3 different word → uses lesson.word ('papa'); short transitionId → states null
    const m3 = out.media.find((m) => m.id === 'm3')!;
    expect(m3.word).toBe('papa');
    expect(m3.starting_state).toBeNull();
    expect(m3.answer).toBe('papa');
  });
});

describe('UserController.userScores', () => {
  it('maps rows: is_seed=true when user_message_id is null, coerces score to number', async () => {
    const rows = [
      {
        score: '1.5',
        created_at: new Date(),
        letter_id: 'l1',
        user_message_id: null,
        grapheme: 'क',
      },
      {
        score: 2,
        created_at: new Date(),
        letter_id: 'l1',
        user_message_id: 'mm-1',
        grapheme: 'क',
      },
    ];
    const scoreRepo = makeRepo({
      manager: { query: jest.fn().mockResolvedValue(rows) },
    });
    const ctrl = makeController({ scoreRepo });

    const out = await ctrl.userScores('u1');
    expect(out).toHaveLength(2);
    expect(out[0].is_seed).toBe(true);
    expect(out[0].score).toBe(1.5);
    expect(out[1].is_seed).toBe(false);
  });
});

describe('UserController.login', () => {
  it('throws BadRequestException when phone is missing', async () => {
    const ctrl = makeController({});
    await expect(
      ctrl.login({ phone: '', password: 'pw' } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when password is missing', async () => {
    const ctrl = makeController({});
    await expect(
      ctrl.login({ phone: '919999990001', password: '' } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws Unauthorized when the user is not found', async () => {
    const userRepo = makeRepo({ findOneBy: jest.fn().mockResolvedValue(null) });
    const ctrl = makeController({ userRepo });
    await expect(
      ctrl.login({ phone: '919999990001', password: 'pw' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws Unauthorized when the user has no password_hash', async () => {
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'u1',
        external_id: '919999990001',
        role: 'dev',
        password_hash: null,
      }),
    });
    const ctrl = makeController({ userRepo });
    await expect(
      ctrl.login({ phone: '919999990001', password: 'pw' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws Unauthorized when the user has no role', async () => {
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'u1',
        external_id: '919999990001',
        role: null,
        password_hash: 'h',
      }),
    });
    const ctrl = makeController({ userRepo });
    await expect(
      ctrl.login({ phone: '919999990001', password: 'pw' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws Unauthorized when bcrypt.compare returns false', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'u1',
        external_id: '919999990001',
        role: 'dev',
        password_hash: 'h',
      }),
    });
    const ctrl = makeController({ userRepo });
    await expect(
      ctrl.login({ phone: '919999990001', password: 'pw' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('returns id/external_id/role on success', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
    const user = {
      id: 'u1',
      external_id: '919999990001',
      role: 'dev',
      password_hash: 'h',
    };
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue(user),
    });
    const ctrl = makeController({ userRepo });

    await expect(
      ctrl.login({ phone: '919999990001', password: 'pw' }),
    ).resolves.toEqual({
      id: 'u1',
      external_id: '919999990001',
      role: 'dev',
    });
  });
});

describe('UserController.patchUser', () => {
  it('throws BadRequest when no fields are provided', async () => {
    const ctrl = makeController({});
    await expect(ctrl.patchUser('u1', {} as never)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('throws NotFoundException when the user does not exist', async () => {
    const userRepo = makeRepo({ findOneBy: jest.fn().mockResolvedValue(null) });
    const ctrl = makeController({ userRepo });
    await expect(ctrl.patchUser('u1', { name: 'Alice' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('applies each provided field and bcrypt-hashes password', async () => {
    (bcrypt.hash as jest.Mock).mockResolvedValueOnce('hashed-pw');
    const user = {
      id: 'u1',
      external_id: 'old',
      name: 'Old',
      role: null,
      password_hash: null,
    };
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockImplementation(async (u) => u),
    });
    const ctrl = makeController({ userRepo });

    const out = await ctrl.patchUser('u1', {
      phone: 'new-phone',
      name: 'Alice',
      password: 'pw',
      role: 'dev',
    });

    expect(bcrypt.hash).toHaveBeenCalledWith('pw', 10);
    expect(out).toEqual({
      id: 'u1',
      external_id: 'new-phone',
      name: 'Alice',
      role: 'dev',
    });
  });
});

describe('UserController.remove', () => {
  it('delegates the param straight to UserService.delete', async () => {
    const del = jest.fn().mockResolvedValue({ deleted: ['u1'], failed: [] });
    const ctrl = makeController({ userSvc: { delete: del } });

    await expect(ctrl.remove('u1')).resolves.toEqual({
      deleted: ['u1'],
      failed: [],
    });
    expect(del).toHaveBeenCalledWith('u1');
  });

  it('forwards an external_id input unchanged', async () => {
    const del = jest
      .fn()
      .mockResolvedValue({ deleted: ['919999990001'], failed: [] });
    const ctrl = makeController({ userSvc: { delete: del } });

    await ctrl.remove('919999990001');
    expect(del).toHaveBeenCalledWith('919999990001');
  });
});

describe('UserController.bulkRemove', () => {
  it('rejects a missing identifiers field', async () => {
    const ctrl = makeController({});
    await expect(ctrl.bulkRemove({} as never)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a non-array identifiers field', async () => {
    const ctrl = makeController({});
    await expect(
      ctrl.bulkRemove({ identifiers: 'u1' } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('delegates the array straight to UserService.delete', async () => {
    const del = jest
      .fn()
      .mockResolvedValue({ deleted: ['u1', 'u2'], failed: [] });
    const ctrl = makeController({ userSvc: { delete: del } });

    const out = await ctrl.bulkRemove({ identifiers: ['u1', 'u2'] });
    expect(out).toEqual({ deleted: ['u1', 'u2'], failed: [] });
    expect(del).toHaveBeenCalledWith(['u1', 'u2']);
  });

  it('passes through the failed entries from UserService', async () => {
    const del = jest.fn().mockResolvedValue({
      deleted: ['u1'],
      failed: [{ input: 'nope', reason: 'user not found' }],
    });
    const ctrl = makeController({ userSvc: { delete: del } });

    const out = await ctrl.bulkRemove({ identifiers: ['u1', 'nope'] });
    expect(out.failed).toEqual([{ input: 'nope', reason: 'user not found' }]);
  });
});

// ─── mutation hardening ───────────────────────────────────────────────────

describe('UserController.dashboard — exact query shape + window construction', () => {
  it('issues the active-users, users, and referrers queries with the exact columns, filters and ordering', async () => {
    const activeUsers = [
      { user_id: 'u1', last_active: new Date('2026-04-27T10:00:00Z') },
    ];
    const users = [
      {
        id: 'u1',
        name: 'Alice',
        external_id: '919999990001',
        referrer_user_id: 'ref-1',
      },
    ];
    const referrers = [
      { id: 'ref-1', name: 'Ref', external_id: '917777770003' },
    ];
    const mediaQB = makeQB(activeUsers);
    const userQB1 = makeQB(users);
    const userQB2 = makeQB(referrers);
    const mediaRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(mediaQB),
    });
    const userRepo = makeRepo({
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(userQB1)
        .mockReturnValueOnce(userQB2),
    });
    const ctrl = makeController({
      userRepo,
      mediaRepo,
      activitySvc: {
        getActivityTime: jest.fn().mockResolvedValue({ results: [] }),
      },
    });

    await ctrl.dashboard('40');

    // Active-users query
    expect(mediaRepo.createQueryBuilder).toHaveBeenCalledWith('mm');
    expect(mediaQB.select).toHaveBeenCalledWith('mm.user_id', 'user_id');
    expect(mediaQB.addSelect).toHaveBeenCalledWith(
      'MAX(mm.created_at)',
      'last_active',
    );
    expect(mediaQB.where).toHaveBeenCalledWith('mm.user_id IS NOT NULL');
    expect(mediaQB.groupBy).toHaveBeenCalledWith('mm.user_id');
    expect(mediaQB.orderBy).toHaveBeenCalledWith('last_active', 'DESC');
    expect(mediaQB.offset).toHaveBeenCalledWith(40);
    expect(mediaQB.limit).toHaveBeenCalledWith(100);

    // Users query
    expect(userRepo.createQueryBuilder).toHaveBeenNthCalledWith(1, 'u');
    expect(userQB1.select).toHaveBeenCalledWith([
      'u.id',
      'u.name',
      'u.external_id',
      'u.referrer_user_id',
    ]);
    expect(userQB1.whereInIds).toHaveBeenCalledWith(['u1']);

    // Referrers query (referrer_user_id was set so it must fire)
    expect(userRepo.createQueryBuilder).toHaveBeenNthCalledWith(2, 'u');
    expect(userQB2.select).toHaveBeenCalledWith([
      'u.id',
      'u.name',
      'u.external_id',
    ]);
    expect(userQB2.whereInIds).toHaveBeenCalledWith(['ref-1']);
  });

  it('skips the referrers query entirely when no user has a referrer', async () => {
    const activeUsers = [{ user_id: 'u1', last_active: new Date() }];
    const users = [
      {
        id: 'u1',
        name: 'A',
        external_id: 'x',
        referrer_user_id: null,
      },
    ];
    const mediaQB = makeQB(activeUsers);
    const userQB = makeQB(users);
    const cqb = jest.fn().mockReturnValueOnce(userQB);
    const userRepo = makeRepo({ createQueryBuilder: cqb });
    const mediaRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(mediaQB),
    });
    const ctrl = makeController({
      userRepo,
      mediaRepo,
      activitySvc: {
        getActivityTime: jest.fn().mockResolvedValue({ results: [] }),
      },
    });
    await ctrl.dashboard();
    // Only the users query fires; the referrers query does not.
    expect(cqb).toHaveBeenCalledTimes(1);
  });

  it('builds exactly 7 contiguous 24h windows ending today (kills addDays(-6) sign + Array.from length)', async () => {
    const activeUsers = [{ user_id: 'u1', last_active: new Date() }];
    const mediaQB = makeQB(activeUsers);
    const userQB = makeQB([
      { id: 'u1', name: 'A', external_id: 'x', referrer_user_id: null },
    ]);
    const userRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(userQB),
    });
    const mediaRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(mediaQB),
    });
    const getActivityTime = jest.fn().mockResolvedValue({ results: [] });
    const ctrl = makeController({
      userRepo,
      mediaRepo,
      activitySvc: { getActivityTime },
    });

    await ctrl.dashboard();

    expect(getActivityTime).toHaveBeenCalledTimes(1);
    const [{ windows }] = getActivityTime.mock.calls[0];
    expect(windows).toHaveLength(7);
    // Each window is exactly 24h long (24 * 60 * 60 * 1000 ms).
    for (const w of windows) {
      const dur = new Date(w.end).getTime() - new Date(w.start).getTime();
      expect(dur).toBe(24 * 60 * 60 * 1000);
    }
    // Consecutive windows are 24h apart (no gaps, no overlap).
    for (let i = 1; i < windows.length; i++) {
      expect(new Date(windows[i].start).getTime()).toBe(
        new Date(windows[i - 1].end).getTime(),
      );
    }
    // First start is 6 days before the last end (7 days total).
    const span =
      new Date(windows[6].end).getTime() - new Date(windows[0].start).getTime();
    expect(span).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('defaults external_id to "" and name to null when the user row is missing the column', async () => {
    const activeUsers = [{ user_id: 'u-missing', last_active: new Date() }];
    const mediaQB = makeQB(activeUsers);
    const userQB = makeQB([]); // user row not returned
    const userRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(userQB),
    });
    const mediaRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(mediaQB),
    });
    const ctrl = makeController({
      userRepo,
      mediaRepo,
      activitySvc: {
        getActivityTime: jest.fn().mockResolvedValue({ results: [] }),
      },
    });
    const out = await ctrl.dashboard();
    expect(out[0].name).toBeNull();
    expect(out[0].external_id).toBe('');
    expect(out[0].referrer).toBeNull();
  });
});

describe('UserController.userMedia — exact query shape + branch handling', () => {
  const userRow = { id: 'u1', name: 'Alice', external_id: '919999990001' };

  it('queries media with the exact where/order/skip/take and assembles transcript + lesson + score sub-queries', async () => {
    const mediaRows = [
      { id: 'm1', s3_key: 'k', created_at: new Date('2026-04-27T10:00:00Z') },
      { id: 'm2', s3_key: null, created_at: new Date('2026-04-27T09:00:00Z') },
    ];
    const transcriptRows = [
      {
        id: 't1',
        input_media_id: 'm1',
        text: 'hi',
        source: 'sarvam',
        created_at: new Date(),
      },
      // Orphan transcript: no input_media_id → must be skipped (kills the
      // `if (!t.input_media_id) continue` block).
      {
        id: 't2',
        input_media_id: null,
        text: 'orphan',
        source: 'azure',
        created_at: new Date(),
      },
    ];
    const lessonStateRows = [
      {
        user_message_id: 'm1',
        word: 'कमल',
        answer: 'क',
        answer_correct: true,
        snapshot: {
          context: { stateTransitionId: 'word-routeWrongLetter-letter' },
        },
      },
    ];
    const transcriptQB = makeQB(transcriptRows);
    const lessonQB = makeQB(lessonStateRows);
    const find = jest.fn().mockResolvedValue(mediaRows);
    const mediaRepo = makeRepo({
      find,
      createQueryBuilder: jest.fn().mockReturnValueOnce(transcriptQB),
    });
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue(userRow),
    });
    const lessonStateRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValueOnce(lessonQB),
    });
    const scoreManagerQuery = jest.fn().mockResolvedValue([
      {
        user_message_id: 'm1',
        grapheme: 'क',
        score: '1.5',
        prev_score: '1.0',
      },
      {
        user_message_id: 'm2',
        grapheme: 'म',
        score: '2.0',
        prev_score: null, // kills the prev_score !== null conditional
      },
    ]);
    const scoreRepo = makeRepo({ manager: { query: scoreManagerQuery } });
    const ctrl = makeController({
      userRepo,
      mediaRepo,
      scoreRepo,
      lessonStateRepo,
    });

    const out = await ctrl.userMedia('u1', '20');

    // media.find exact shape
    expect(find).toHaveBeenCalledWith({
      where: { user_id: 'u1', source: 'whatsapp', media_type: 'audio' },
      order: { created_at: 'DESC' },
      skip: 20,
      take: 100,
    });

    // transcripts QB
    expect(mediaRepo.createQueryBuilder).toHaveBeenCalledWith('mm');
    expect(transcriptQB.select).toHaveBeenCalledWith([
      'mm.id',
      'mm.input_media_id',
      'mm.text',
      'mm.source',
      'mm.created_at',
    ]);
    expect(transcriptQB.where).toHaveBeenCalledWith(
      'mm.input_media_id IN (:...mediaIds)',
      { mediaIds: ['m1', 'm2'] },
    );

    // lessonStates QB
    expect(lessonStateRepo.createQueryBuilder).toHaveBeenCalledWith('ls');
    expect(lessonQB.select).toHaveBeenCalledWith([
      'ls.user_message_id',
      'ls.word',
      'ls.answer',
      'ls.answer_correct',
      'ls.snapshot',
    ]);
    expect(lessonQB.where).toHaveBeenCalledWith(
      'ls.user_message_id IN (:...mediaIds)',
      { mediaIds: ['m1', 'm2'] },
    );
    expect(lessonQB.orderBy).toHaveBeenCalledWith('ls.created_at', 'ASC');

    // Score-change SQL + params
    expect(scoreManagerQuery).toHaveBeenCalledTimes(1);
    expect(scoreManagerQuery.mock.calls[0][0]).toContain('WITH windowed AS');
    expect(scoreManagerQuery.mock.calls[0][0]).toContain(
      'LAG(s.score) OVER (PARTITION BY s.letter_id ORDER BY s.created_at)',
    );
    expect(scoreManagerQuery.mock.calls[0][1]).toEqual(['u1', ['m1', 'm2']]);

    // Orphan transcript (no input_media_id) is dropped.
    expect(out.media.map((m) => m.transcripts)).toEqual([
      [
        {
          text: 'hi',
          source: 'sarvam',
          created_at: expect.any(Date),
        },
      ],
      [], // m2 has no transcript
    ]);

    // transitionId parses → starting_state from parts[1], final_state from parts[2]
    expect(out.media[0].starting_state).toBe('routeWrongLetter');
    expect(out.media[0].final_state).toBe('letter');

    // prev_score null is preserved as null in the output; numeric strings coerced to number.
    const sc1 = out.media[0].score_changes[0];
    expect(sc1.score).toBe(1.5);
    expect(sc1.prev_score).toBe(1.0);
    const sc2 = out.media[1].score_changes[0];
    expect(sc2.score).toBe(2.0);
    expect(sc2.prev_score).toBeNull();

    // has_audio = !!m.s3_key
    expect(out.media[0].has_audio).toBe(true);
    expect(out.media[1].has_audio).toBe(false);
  });

  it('parses transitionIds with only 2 parts as no starting/final state (kills parts.length >= 3 → >)', async () => {
    const mediaRows = [{ id: 'm1', s3_key: null, created_at: new Date() }];
    const lessonStateRows = [
      {
        user_message_id: 'm1',
        word: 'क',
        answer: null,
        answer_correct: null,
        snapshot: { context: { stateTransitionId: 'foo-bar' } }, // 2 parts only
      },
    ];
    const mediaRepo = makeRepo({
      find: jest.fn().mockResolvedValue(mediaRows),
      createQueryBuilder: jest.fn().mockReturnValue(makeQB([])),
    });
    const lessonStateRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(makeQB(lessonStateRows)),
    });
    const scoreRepo = makeRepo({
      manager: { query: jest.fn().mockResolvedValue([]) },
    });
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue(userRow),
    });
    const ctrl = makeController({
      userRepo,
      mediaRepo,
      scoreRepo,
      lessonStateRepo,
    });
    const out = await ctrl.userMedia('u1');
    expect(out.media[0].starting_state).toBeNull();
    expect(out.media[0].final_state).toBeNull();
  });

  it('rolls the displayed answer back by one within a word and resets on a word boundary', async () => {
    // Media is fetched in DESC order. Iteration goes oldest → newest. For
    // consecutive same-word answers we display the PREVIOUS row's `answer`;
    // when the word changes we display the new word as the displayed answer.
    const mediaRows = [
      { id: 'm3', s3_key: null, created_at: new Date('2026-04-27T12:00:00Z') }, // newest
      { id: 'm2', s3_key: null, created_at: new Date('2026-04-27T11:00:00Z') },
      { id: 'm1', s3_key: null, created_at: new Date('2026-04-27T10:00:00Z') }, // oldest
    ];
    const lessonStateRows = [
      // m1 (oldest): first row of a word → displayed = lesson.word
      {
        user_message_id: 'm1',
        word: 'कमल',
        answer: 'क',
        answer_correct: true,
        snapshot: { context: { stateTransitionId: 'a-b-c' } },
      },
      // m2 (mid): same word → displayed = prev row's lesson.answer ('क')
      {
        user_message_id: 'm2',
        word: 'कमल',
        answer: 'म',
        answer_correct: true,
        snapshot: { context: { stateTransitionId: 'a-b-c' } },
      },
      // m3 (newest): word CHANGED → displayed = lesson.word ('पानी')
      {
        user_message_id: 'm3',
        word: 'पानी',
        answer: 'प',
        answer_correct: true,
        snapshot: { context: { stateTransitionId: 'a-b-c' } },
      },
    ];
    const mediaRepo = makeRepo({
      find: jest.fn().mockResolvedValue(mediaRows),
      createQueryBuilder: jest.fn().mockReturnValue(makeQB([])),
    });
    const lessonStateRepo = makeRepo({
      createQueryBuilder: jest.fn().mockReturnValue(makeQB(lessonStateRows)),
    });
    const scoreRepo = makeRepo({
      manager: { query: jest.fn().mockResolvedValue([]) },
    });
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue(userRow),
    });
    const ctrl = makeController({
      userRepo,
      mediaRepo,
      scoreRepo,
      lessonStateRepo,
    });
    const out = await ctrl.userMedia('u1');
    const byId = new Map(out.media.map((m) => [m.id, m]));
    expect(byId.get('m1')!.answer).toBe('कमल'); // first row of the word
    expect(byId.get('m2')!.answer).toBe('क'); // prev row's lesson.answer
    expect(byId.get('m3')!.answer).toBe('पानी'); // word changed
  });

  it('returns empty media + user info when the user has no whatsapp audio', async () => {
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue(userRow),
    });
    const mediaRepo = makeRepo({ find: jest.fn().mockResolvedValue([]) });
    const ctrl = makeController({ userRepo, mediaRepo });
    const out = await ctrl.userMedia('u1');
    expect(out).toEqual({
      user: { name: 'Alice', phone: '919999990001' },
      media: [],
    });
  });
});

describe('UserController.userScores — exact raw SQL', () => {
  it('joins scores with letters and orders ASC; reports is_seed when user_message_id is null', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        score: '1.5',
        created_at: new Date('2026-04-27T10:00:00Z'),
        letter_id: 'L1',
        grapheme: 'क',
        user_message_id: null,
      },
      {
        score: '2.5',
        created_at: new Date('2026-04-27T11:00:00Z'),
        letter_id: 'L2',
        grapheme: 'म',
        user_message_id: 'mm-1',
      },
    ]);
    const scoreRepo = makeRepo({ manager: { query } });
    const ctrl = makeController({ scoreRepo });
    const out = await ctrl.userScores('u1');
    expect(query.mock.calls[0][0]).toContain('FROM scores s');
    expect(query.mock.calls[0][0]).toContain(
      'JOIN letters l ON l.id = s.letter_id',
    );
    expect(query.mock.calls[0][0]).toContain('WHERE s.user_id = $1');
    expect(query.mock.calls[0][0]).toContain('ORDER BY s.created_at ASC');
    expect(query.mock.calls[0][1]).toEqual(['u1']);
    expect(out).toEqual([
      {
        score: 1.5,
        created_at: expect.any(Date),
        letter_id: 'L1',
        grapheme: 'क',
        is_seed: true,
        user_message_id: null,
      },
      {
        score: 2.5,
        created_at: expect.any(Date),
        letter_id: 'L2',
        grapheme: 'म',
        is_seed: false,
        user_message_id: 'mm-1',
      },
    ]);
  });
});

describe('UserController.login + patchUser — bcrypt args', () => {
  beforeEach(() => {
    (bcrypt.compare as jest.Mock).mockReset();
    (bcrypt.hash as jest.Mock).mockReset();
  });

  it('login calls bcrypt.compare(password, password_hash)', async () => {
    const user = {
      id: 'u1',
      external_id: '919999990001',
      password_hash: 'hash',
      role: 'admin',
    };
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue(user),
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    const ctrl = makeController({ userRepo });
    await ctrl.login({ phone: '919999990001', password: 'pw' } as never);
    expect(bcrypt.compare).toHaveBeenCalledWith('pw', 'hash');
  });

  it('patchUser bcrypts the new password with rounds=10', async () => {
    const user = { id: 'u1', external_id: 'x', name: null, role: 'admin' };
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockResolvedValue(undefined),
    });
    (bcrypt.hash as jest.Mock).mockResolvedValue('newhash');
    const ctrl = makeController({ userRepo });
    await ctrl.patchUser('u1', { password: 'newpw' } as never);
    expect(bcrypt.hash).toHaveBeenCalledWith('newpw', 10);
    expect(userRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ password_hash: 'newhash' }),
    );
  });
});
