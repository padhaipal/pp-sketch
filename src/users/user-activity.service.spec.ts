// Unit tests for UserActivityService. TypeORM repos and the fluent
// QueryBuilder are mocked.

import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { UserActivityService } from './user-activity.service';
import type { UserEntity } from './user.entity';
import type { MediaMetaDataEntity } from '../media-meta-data/media-meta-data.entity';

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = '22222222-3333-4444-5555-666666666666';

type UserRepoMock = {
  find: jest.Mock;
};

// fluent QueryBuilder mock — every chain method returns the same object,
// only getRawMany triggers a resolved Promise.
function makeQB(rows: unknown[]): Record<string, jest.Mock> {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  for (const k of Object.keys(qb)) {
    if (k !== 'getRawMany') qb[k].mockReturnValue(qb);
  }
  return qb;
}

function makeUserRepo(find: jest.Mock): UserRepoMock {
  return { find };
}

function makeMediaRepo(
  rows: unknown[],
): { createQueryBuilder: jest.Mock; _qb: Record<string, jest.Mock> } {
  const qb = makeQB(rows);
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    _qb: qb,
  };
}

function makeService(
  userRepo: UserRepoMock,
  mediaRepo: { createQueryBuilder: jest.Mock },
): UserActivityService {
  return new UserActivityService(
    userRepo as unknown as Repository<UserEntity>,
    mediaRepo as unknown as Repository<MediaMetaDataEntity>,
  );
}

describe('UserActivityService.getActivityTime — window parsing', () => {
  it('throws BadRequest when start/end are not valid ISO 8601', async () => {
    const svc = makeService(makeUserRepo(jest.fn()), makeMediaRepo([]));
    await expect(
      svc.getActivityTime({
        users: ['919999990001'],
        windows: [{ start: 'not-a-date', end: '2026-04-27T10:00:00Z' }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequest when start > end', async () => {
    const svc = makeService(makeUserRepo(jest.fn()), makeMediaRepo([]));
    await expect(
      svc.getActivityTime({
        users: ['919999990001'],
        windows: [
          { start: '2026-04-27T11:00:00Z', end: '2026-04-27T10:00:00Z' },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequest on an empty/whitespace user identifier', async () => {
    const svc = makeService(makeUserRepo(jest.fn()), makeMediaRepo([]));
    await expect(
      svc.getActivityTime({
        users: ['   '],
        windows: [{ start: '2026-04-27T10:00:00Z', end: '2026-04-27T11:00:00Z' }],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('UserActivityService.getActivityTime — empty inputs', () => {
  it('returns {results:[]} when no users resolve', async () => {
    const svc = makeService(
      makeUserRepo(jest.fn().mockResolvedValue([])),
      makeMediaRepo([]),
    );
    const out = await svc.getActivityTime({
      users: ['919999990001'],
      windows: [{ start: '2026-04-27T10:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(out).toEqual({ results: [] });
  });
});

describe('UserActivityService.getActivityTime — active-ms computation', () => {
  it('sums gaps strictly below 60 s and excludes longer gaps', async () => {
    // 5 messages in one window; only the first 30s and last 20s gaps count.
    const userA = { id: UUID_A, external_id: '919999990001' };
    const userRepo = makeUserRepo(jest.fn().mockResolvedValue([userA]));
    const rows = [
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:00:00Z') },
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:00:30Z') }, // +30s
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:01:50Z') }, // +80s, skip
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:05:10Z') }, // +200s, skip
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:05:30Z') }, // +20s
    ];
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(userRepo, mediaRepo);

    const out = await svc.getActivityTime({
      users: [UUID_A],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });

    expect(out.results[0].windows[0].active_ms).toBe(50_000);
  });

  it('coerces string timestamps from the query result into Date objects', async () => {
    const userA = { id: UUID_A, external_id: '919999990001' };
    const userRepo = makeUserRepo(jest.fn().mockResolvedValue([userA]));
    const rows = [
      { user_id: UUID_A, created_at: '2026-04-27T10:00:00Z' },
      { user_id: UUID_A, created_at: '2026-04-27T10:00:30Z' },
    ];
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(userRepo, mediaRepo);

    const out = await svc.getActivityTime({
      users: [UUID_A],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });

    expect(out.results[0].windows[0].active_ms).toBe(30_000);
  });

  it('excludes messages outside the window and resets the gap chain', async () => {
    const userA = { id: UUID_A, external_id: '919999990001' };
    const userRepo = makeUserRepo(jest.fn().mockResolvedValue([userA]));
    // m0 and m1 in window, m2 outside, m3 back inside → gap m1→m3 must NOT count
    const rows = [
      { user_id: UUID_A, created_at: new Date('2026-04-27T09:30:00Z') },
      { user_id: UUID_A, created_at: new Date('2026-04-27T09:30:10Z') }, // +10s ✓
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:30:00Z') }, // outside
      { user_id: UUID_A, created_at: new Date('2026-04-27T11:00:30Z') }, // back in (next window only)
    ];
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(userRepo, mediaRepo);

    const out = await svc.getActivityTime({
      users: [UUID_A],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T09:45:00Z' }],
    });
    expect(out.results[0].windows[0].active_ms).toBe(10_000);
  });

  it('returns 0 active_ms when only one (or zero) messages fall in the window', async () => {
    const userA = { id: UUID_A, external_id: '919999990001' };
    const userRepo = makeUserRepo(jest.fn().mockResolvedValue([userA]));
    const rows = [
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:00:00Z') },
    ];
    const svc = makeService(userRepo, makeMediaRepo(rows));

    const out = await svc.getActivityTime({
      users: [UUID_A],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(out.results[0].windows[0].active_ms).toBe(0);
  });
});

describe('UserActivityService.getActivityTime — user identification', () => {
  it('routes UUIDs to find({id:In(...)}) and external_ids to find({external_id:In(...)})', async () => {
    const userA = { id: UUID_A, external_id: '919999990001' };
    const userB = { id: UUID_B, external_id: '918888880002' };

    const find = jest
      .fn()
      // first call: id batch
      .mockResolvedValueOnce([userA])
      // second call: external_id batch
      .mockResolvedValueOnce([userB]);

    const svc = makeService(makeUserRepo(find), makeMediaRepo([]));
    const out = await svc.getActivityTime({
      users: [UUID_A, '918888880002'],
      windows: [{ start: '2026-04-27T10:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });

    expect(find).toHaveBeenCalledTimes(2);
    expect(out.results.map((r) => r.user_id)).toEqual([UUID_A, UUID_B]);
  });

  it('dedupes when the same user is referenced by both id and external_id, preserving first-seen order', async () => {
    const userA = { id: UUID_A, external_id: '919999990001' };
    const find = jest
      .fn()
      .mockResolvedValueOnce([userA]) // id batch
      .mockResolvedValueOnce([userA]); // external_id batch
    const svc = makeService(makeUserRepo(find), makeMediaRepo([]));

    const out = await svc.getActivityTime({
      users: [UUID_A, '919999990001'],
      windows: [{ start: '2026-04-27T10:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });

    expect(out.results).toHaveLength(1);
    expect(out.results[0].user_id).toBe(UUID_A);
  });

  it('skips IDs that resolve to no user', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const svc = makeService(makeUserRepo(find), makeMediaRepo([]));

    const out = await svc.getActivityTime({
      users: ['nonexistent-phone-999999999999'],
      windows: [{ start: '2026-04-27T10:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(out.results).toEqual([]);
  });
});

describe('UserActivityService.didJustCrossDailyActivityThreshold', () => {
  // 5 minutes = 300_000 ms
  const THRESHOLD = 5 * 60 * 1000;

  it('returns false when fewer than 2 messages exist today', async () => {
    const userRepo = makeUserRepo(jest.fn());
    const mediaRepo = makeMediaRepo([
      { user_id: UUID_A, created_at: new Date() },
    ]);
    const svc = makeService(userRepo, mediaRepo);

    await expect(
      svc.didJustCrossDailyActivityThreshold({
        user_id: UUID_A,
        threshold_ms: THRESHOLD,
      }),
    ).resolves.toBe(false);
  });

  it('returns true when the latest message pushes total over threshold', async () => {
    // 7 messages spaced 51s apart: 6 gaps × 51s = 306s after (>300s), 5 × 51s = 255s before (≤300s) → just crossed.
    const userRepo = makeUserRepo(jest.fn());
    const now = Date.now();
    const rows = Array.from({ length: 7 }, (_, i) => ({
      user_id: UUID_A,
      created_at: new Date(now - (6 - i) * 51_000),
    }));
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(userRepo, mediaRepo);

    await expect(
      svc.didJustCrossDailyActivityThreshold({
        user_id: UUID_A,
        threshold_ms: THRESHOLD,
      }),
    ).resolves.toBe(true);
  });

  it('returns false when threshold was already crossed by an earlier message (dedup)', async () => {
    // 8 messages spaced 51s apart: both before/after exceed threshold.
    const userRepo = makeUserRepo(jest.fn());
    const now = Date.now();
    const rows = Array.from({ length: 8 }, (_, i) => ({
      user_id: UUID_A,
      created_at: new Date(now - (7 - i) * 51_000),
    }));
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(userRepo, mediaRepo);

    await expect(
      svc.didJustCrossDailyActivityThreshold({
        user_id: UUID_A,
        threshold_ms: THRESHOLD,
      }),
    ).resolves.toBe(false);
  });
});
