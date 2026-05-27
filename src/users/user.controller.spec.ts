process.env.LOG_PII_HMAC_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
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

type SimpleRepo = {
  findOneBy: jest.Mock;
  find: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
  createQueryBuilder: jest.Mock;
  manager: { query: jest.Mock };
};

function makeQB(rows: unknown[] | ((args: unknown) => unknown[])): Record<string, jest.Mock> {
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
    getRawMany: jest.fn().mockImplementation(async () =>
      typeof rows === 'function' ? rows(undefined) : rows,
    ),
    getMany: jest.fn().mockImplementation(async () =>
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
}): UserController {
  return new UserController(
    (opts.userRepo ?? makeRepo()) as unknown as Repository<UserEntity>,
    (opts.mediaRepo ?? makeRepo()) as unknown as Repository<MediaMetaDataEntity>,
    (opts.scoreRepo ?? makeRepo()) as unknown as Repository<ScoreEntity>,
    (opts.lessonStateRepo ?? makeRepo()) as unknown as Repository<LiteracyLessonStateEntity>,
    (opts.activitySvc ?? {}) as UserActivityService,
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
    const mediaRepo = makeRepo({ createQueryBuilder: jest.fn().mockReturnValue(mediaQB) });
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
    const activeUsers = [
      { user_id: 'u1', last_active: new Date() },
    ];
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
      { id: 'm3', created_at: new Date('2026-04-27T12:00:00Z'), s3_key: 's3-3' },
      { id: 'm2', created_at: new Date('2026-04-27T11:00:00Z'), s3_key: null },
      { id: 'm1', created_at: new Date('2026-04-27T10:00:00Z'), s3_key: 's3-1' },
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
      findOneBy: jest
        .fn()
        .mockResolvedValue({ id: 'u1', external_id: '919999990001', role: 'dev', password_hash: null }),
    });
    const ctrl = makeController({ userRepo });
    await expect(
      ctrl.login({ phone: '919999990001', password: 'pw' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws Unauthorized when the user has no role', async () => {
    const userRepo = makeRepo({
      findOneBy: jest
        .fn()
        .mockResolvedValue({ id: 'u1', external_id: '919999990001', role: null, password_hash: 'h' }),
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
    await expect(
      ctrl.patchUser('u1', { name: 'Alice' }),
    ).rejects.toThrow(NotFoundException);
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
  it('throws NotFoundException when the user does not exist', async () => {
    const userRepo = makeRepo({ findOneBy: jest.fn().mockResolvedValue(null) });
    const ctrl = makeController({ userRepo });
    await expect(ctrl.remove('u1')).rejects.toThrow(NotFoundException);
  });

  it('removes via the repo and returns {deleted:true}', async () => {
    const user = { id: 'u1', external_id: '919999990001' };
    const userRepo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue(user),
      remove: jest.fn().mockResolvedValue(undefined),
    });
    const ctrl = makeController({ userRepo });

    await expect(ctrl.remove('u1')).resolves.toEqual({ deleted: true });
    expect(userRepo.remove).toHaveBeenCalledWith(user);
  });
});
