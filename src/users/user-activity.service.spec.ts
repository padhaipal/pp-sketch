// Unit tests for UserActivityService. TypeORM repos and the fluent
// QueryBuilder are mocked.

// uuid is ESM-only — provide a CJS-shaped mock. validate uses the loose
// hex-shape regex (no version/variant nibble checks) so test fixtures with
// arbitrary hex bytes still classify as uuids.
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'gen-uuid'),
  validate: (s: unknown): boolean =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));

import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { UserActivityService } from './user-activity.service';
import type { UserService } from './user.service';
import { partitionUserIdentifiers } from './user.dto';
import type { UserEntity } from './user.entity';
import type { MediaMetaDataEntity } from '../media-meta-data/media-meta-data.entity';

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = '22222222-3333-4444-5555-666666666666';

type UserRepoMock = {
  find: jest.Mock;
};

// fluent QueryBuilder mock — every chain method returns the same object,
// only getRawMany triggers a resolved Promise. `andWhere` additionally
// executes a Brackets argument's whereFactory against the same qb so the
// nested `where`/`andWhere` calls register on the mock too.
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
  qb.andWhere.mockImplementation((...args: unknown[]) => {
    const a0 = args[0] as { whereFactory?: (q: unknown) => void } | undefined;
    if (a0 && typeof a0.whereFactory === 'function') a0.whereFactory(qb);
    return qb;
  });
  return qb;
}

function makeUserRepo(find: jest.Mock): UserRepoMock {
  return { find };
}

function makeMediaRepo(rows: unknown[]): {
  createQueryBuilder: jest.Mock;
  _qb: Record<string, jest.Mock>;
} {
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
  const userService = {
    partitionIdentifiers: partitionUserIdentifiers,
  } as unknown as UserService;
  return new UserActivityService(
    userRepo as unknown as Repository<UserEntity>,
    mediaRepo as unknown as Repository<MediaMetaDataEntity>,
    userService,
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
        windows: [
          { start: '2026-04-27T10:00:00Z', end: '2026-04-27T11:00:00Z' },
        ],
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
  it('sums gaps strictly below 120 s and excludes longer gaps', async () => {
    // 5 messages in one window; the 30s, 80s and 20s gaps count, 200s skips.
    const userA = { id: UUID_A, external_id: '919999990001' };
    const userRepo = makeUserRepo(jest.fn().mockResolvedValue([userA]));
    const rows = [
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:00:00Z') },
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:00:30Z') }, // +30s
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:01:50Z') }, // +80s
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:05:10Z') }, // +200s, skip
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:05:30Z') }, // +20s
    ];
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(userRepo, mediaRepo);

    const out = await svc.getActivityTime({
      users: [UUID_A],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });

    expect(out.results[0].windows[0].active_ms).toBe(130_000);
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

  it('drops well-shaped identifiers that have no matching user (lookup miss, not shape error)', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const svc = makeService(makeUserRepo(find), makeMediaRepo([]));

    const out = await svc.getActivityTime({
      users: ['919999990001'],
      windows: [{ start: '2026-04-27T10:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(out.results).toEqual([]);
  });

  it('throws BadRequestException for malformed identifiers (not uuid, not valid E.164), listing all bad items in one message', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const svc = makeService(makeUserRepo(find), makeMediaRepo([]));

    await expect(
      svc.getActivityTime({
        users: ['nonexistent-phone-999999999999', 'also-bad'],
        windows: [
          { start: '2026-04-27T10:00:00Z', end: '2026-04-27T11:00:00Z' },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.getActivityTime({
        users: ['nonexistent-phone-999999999999', 'also-bad'],
        windows: [
          { start: '2026-04-27T10:00:00Z', end: '2026-04-27T11:00:00Z' },
        ],
      }),
    ).rejects.toThrow(/nonexistent-phone-999999999999.*also-bad/);
  });
});

describe('UserActivityService.getTodayActiveTime', () => {
  beforeEach(() => {
    // Pin "now" to midday IST. These fixtures place messages a few minutes
    // in the past relative to now; with real time, a CI run in the first
    // minutes after IST midnight puts those messages on yesterday's side
    // of the boundary and the expected totals drop (observed: gate run at
    // 00:05 IST, 2026-07-09).
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T06:30:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns 0/0 when no messages exist today', async () => {
    const userRepo = makeUserRepo(jest.fn());
    const mediaRepo = makeMediaRepo([]);
    const svc = makeService(userRepo, mediaRepo);

    await expect(svc.getTodayActiveTime(UUID_A)).resolves.toEqual({
      withLatestTurn: 0,
      withoutLatestTurn: 0,
    });
  });

  it('returns 0/0 when only one message exists today (no gaps)', async () => {
    const userRepo = makeUserRepo(jest.fn());
    const mediaRepo = makeMediaRepo([
      { user_id: UUID_A, created_at: new Date() },
    ]);
    const svc = makeService(userRepo, mediaRepo);

    await expect(svc.getTodayActiveTime(UUID_A)).resolves.toEqual({
      withLatestTurn: 0,
      withoutLatestTurn: 0,
    });
  });

  it('returns active ms including and excluding the latest message', async () => {
    // 7 messages spaced 51s apart: withLatestTurn = 6 gaps × 51s = 306s,
    // withoutLatestTurn = 5 gaps × 51s = 255s. A caller checking the 5-min
    // threshold sees 255_000 < 300_000 <= 306_000 → crossing turn.
    const userRepo = makeUserRepo(jest.fn());
    const now = Date.now();
    const rows = Array.from({ length: 7 }, (_, i) => ({
      user_id: UUID_A,
      created_at: new Date(now - (6 - i) * 51_000),
    }));
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(userRepo, mediaRepo);

    await expect(svc.getTodayActiveTime(UUID_A)).resolves.toEqual({
      withLatestTurn: 306_000,
      withoutLatestTurn: 255_000,
    });
  });

  it('returns both values above a crossed threshold on the following turn (caller-side dedup)', async () => {
    // 8 messages spaced 51s apart: withoutLatestTurn = 306s, withLatestTurn =
    // 357s — both over the 5-min mark, so a caller's crossing test
    // (withoutLatestTurn < T) no longer matches. This is what makes the
    // milestone fire exactly once per day.
    const userRepo = makeUserRepo(jest.fn());
    const now = Date.now();
    const rows = Array.from({ length: 8 }, (_, i) => ({
      user_id: UUID_A,
      created_at: new Date(now - (7 - i) * 51_000),
    }));
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(userRepo, mediaRepo);

    await expect(svc.getTodayActiveTime(UUID_A)).resolves.toEqual({
      withLatestTurn: 357_000,
      withoutLatestTurn: 306_000,
    });
  });
});

// ─── mutation hardening ─────────────────────────────────────────────────────

describe('UserActivityService — exact query shape', () => {
  const userA = { id: UUID_A, external_id: '919999990001' };

  it('builds the voice-message query with the exact columns, filters, ordering and parameter set', async () => {
    const userRepo = makeUserRepo(jest.fn().mockResolvedValue([userA]));
    const mediaRepo = makeMediaRepo([]);
    const svc = makeService(userRepo, mediaRepo);
    await svc.getActivityTime({
      users: [UUID_A],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    const qb = mediaRepo._qb;
    expect(mediaRepo.createQueryBuilder).toHaveBeenCalledWith('mm');
    expect(qb.select).toHaveBeenCalledWith('mm.user_id', 'user_id');
    expect(qb.addSelect).toHaveBeenCalledWith('mm.created_at', 'created_at');
    expect(qb.where).toHaveBeenCalledWith('mm.user_id IN (:...userIds)', {
      userIds: [UUID_A],
    });
    expect(qb.andWhere).toHaveBeenCalledWith('mm.source = :source', {
      source: 'whatsapp',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('mm.media_type = :media_type', {
      media_type: 'audio',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('mm.rolled_back = :rolled_back', {
      rolled_back: false,
    });
    expect(qb.orderBy).toHaveBeenCalledWith('mm.user_id', 'ASC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('mm.created_at', 'ASC');
    // Inner Brackets clause — executed by the mock so the inner calls register.
    expect(qb.where).toHaveBeenCalledWith('mm.created_at >= :earliestStart', {
      earliestStart: new Date('2026-04-27T09:00:00Z'),
    });
    expect(qb.andWhere).toHaveBeenCalledWith('mm.created_at <= :latestEnd', {
      latestEnd: new Date('2026-04-27T11:00:00Z'),
    });
  });

  it('reduces multiple non-monotonic windows to the EARLIEST start and LATEST end (kills the < / > reduce comparators)', async () => {
    const userRepo = makeUserRepo(jest.fn().mockResolvedValue([userA]));
    const mediaRepo = makeMediaRepo([]);
    const svc = makeService(userRepo, mediaRepo);
    await svc.getActivityTime({
      users: [UUID_A],
      windows: [
        { start: '2026-04-27T10:00:00Z', end: '2026-04-27T11:00:00Z' },
        { start: '2026-04-27T08:00:00Z', end: '2026-04-27T09:30:00Z' }, // earliest
        { start: '2026-04-27T12:00:00Z', end: '2026-04-27T13:00:00Z' }, // latest
      ],
    });
    const qb = mediaRepo._qb;
    expect(qb.where).toHaveBeenCalledWith('mm.created_at >= :earliestStart', {
      earliestStart: new Date('2026-04-27T08:00:00Z'),
    });
    expect(qb.andWhere).toHaveBeenCalledWith('mm.created_at <= :latestEnd', {
      latestEnd: new Date('2026-04-27T13:00:00Z'),
    });
  });
});

describe('UserActivityService.getActivityTime — boundary conditions', () => {
  const userA = { id: UUID_A, external_id: '919999990001' };

  it('a gap of EXACTLY 0 ms (duplicate timestamps) contributes 0 active_ms (kills gap > 0 → >=)', async () => {
    const userRepo = makeUserRepo(jest.fn().mockResolvedValue([userA]));
    const t = new Date('2026-04-27T10:00:00Z');
    const rows = [
      { user_id: UUID_A, created_at: t },
      { user_id: UUID_A, created_at: t },
    ];
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(userRepo, mediaRepo);
    const out = await svc.getActivityTime({
      users: [UUID_A],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(out.results[0].windows[0].active_ms).toBe(0);
  });

  it('a gap of EXACTLY 119_999 ms is included but EXACTLY 120_000 ms is excluded (kills gap < 120_000 → <=)', async () => {
    const userRepo = makeUserRepo(jest.fn().mockResolvedValue([userA]));
    const rows = [
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:00:00.000Z') },
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:01:59.999Z') }, // +119999 ✓
      { user_id: UUID_A, created_at: new Date('2026-04-27T10:03:59.999Z') }, // +120000 ✗
    ];
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(userRepo, mediaRepo);
    const out = await svc.getActivityTime({
      users: [UUID_A],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(out.results[0].windows[0].active_ms).toBe(119_999);
  });

  it('messages at EXACTLY the window start/end are included (kills t < startMs → <= and t > endMs → >=)', async () => {
    const userRepo = makeUserRepo(jest.fn().mockResolvedValue([userA]));
    const rows = [
      { user_id: UUID_A, created_at: new Date('2026-04-27T09:00:00Z') }, // = start
      { user_id: UUID_A, created_at: new Date('2026-04-27T09:00:30Z') }, // +30s ✓
      { user_id: UUID_A, created_at: new Date('2026-04-27T11:00:00Z') }, // = end (gap too large)
    ];
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(userRepo, mediaRepo);
    const out = await svc.getActivityTime({
      users: [UUID_A],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    // m0→m1 = 30s counted; m1→m2 ≫ 60s excluded. If start/end were exclusive
    // (< → <= and > → >=) m0 and m2 would drop out and active would still be 0
    // from m1 alone → the assertion below catches both flips.
    expect(out.results[0].windows[0].active_ms).toBe(30_000);
  });

  it('a zero-length window (start === end) is allowed (kills start > end → >=)', async () => {
    const userRepo = makeUserRepo(jest.fn().mockResolvedValue([userA]));
    const mediaRepo = makeMediaRepo([]);
    const svc = makeService(userRepo, mediaRepo);
    await expect(
      svc.getActivityTime({
        users: [UUID_A],
        windows: [
          { start: '2026-04-27T10:00:00Z', end: '2026-04-27T10:00:00Z' },
        ],
      }),
    ).resolves.toBeDefined();
  });
});

describe('UserActivityService.getTodayActiveTime — boundary conditions', () => {
  beforeEach(() => {
    // Fix "now" to the middle of an IST day so all relative timestamps stay
    // within today's IST window.
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T18:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns exact ms values, latest gap of 119_999 ms included (kills gap < 120_000 → <=)', async () => {
    // 7 msgs at 50_000 ms gaps → withoutLatestTurn = 6 × 50_000 = 300_000;
    // an 8th msg 119_999 ms later → withLatestTurn = 419_999.
    const now = Date.now();
    const rows: { user_id: string; created_at: Date }[] = [];
    for (let i = 0; i < 7; i++) {
      rows.push({
        user_id: UUID_A,
        created_at: new Date(now - 119_999 - (6 - i) * 50_000),
      });
    }
    rows.push({ user_id: UUID_A, created_at: new Date(now) });
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(makeUserRepo(jest.fn()), mediaRepo);
    await expect(svc.getTodayActiveTime(UUID_A)).resolves.toEqual({
      withLatestTurn: 419_999,
      withoutLatestTurn: 300_000,
    });
  });

  it('a latest gap of EXACTLY 120_000 ms adds nothing — withLatestTurn === withoutLatestTurn', async () => {
    // 7 msgs at 50_000 ms gaps, then an 8th exactly 120_000 ms later: the last
    // gap is excluded by the < 120s rule so both values are 300_000. A caller's
    // crossing test can never fire on a turn that follows a full break.
    const now = Date.now();
    const rows: { user_id: string; created_at: Date }[] = [];
    for (let i = 0; i < 7; i++) {
      rows.push({
        user_id: UUID_A,
        created_at: new Date(now - 120_000 - (6 - i) * 50_000),
      });
    }
    rows.push({ user_id: UUID_A, created_at: new Date(now) });
    const mediaRepo = makeMediaRepo(rows);
    const svc = makeService(makeUserRepo(jest.fn()), mediaRepo);
    await expect(svc.getTodayActiveTime(UUID_A)).resolves.toEqual({
      withLatestTurn: 300_000,
      withoutLatestTurn: 300_000,
    });
  });

  it("uses IST midnight as the lower bound of today's active window", async () => {
    // Now = 2026-05-15T18:00:00Z UTC = 2026-05-15 23:30 IST.
    // Today's IST midnight = 2026-05-15T00:00 IST = 2026-05-14T18:30:00Z UTC.
    const mediaRepo = makeMediaRepo([]);
    const svc = makeService(makeUserRepo(jest.fn()), mediaRepo);
    await svc.getTodayActiveTime(UUID_A);
    const qb = mediaRepo._qb;
    expect(qb.where).toHaveBeenCalledWith('mm.created_at >= :earliestStart', {
      earliestStart: new Date('2026-05-14T18:30:00Z'),
    });
    expect(qb.andWhere).toHaveBeenCalledWith('mm.created_at <= :latestEnd', {
      latestEnd: new Date('2026-05-15T18:00:00Z'),
    });
  });

  it('queries voice messages for exactly the requested user id', async () => {
    const mediaRepo = makeMediaRepo([]);
    const svc = makeService(makeUserRepo(jest.fn()), mediaRepo);
    await svc.getTodayActiveTime(UUID_A);
    expect(mediaRepo._qb.where).toHaveBeenCalledWith(
      'mm.user_id IN (:...userIds)',
      { userIds: [UUID_A] },
    );
  });
});

describe('UserActivityService.getActivityTime — user resolution branches', () => {
  const userA = { id: UUID_A, external_id: '919999990001' };

  it('only the UUID branch fires when every input is a UUID (kills ids.length > 0 → >=)', async () => {
    const find = jest.fn().mockResolvedValue([userA]);
    const svc = makeService(makeUserRepo(find), makeMediaRepo([]));
    await svc.getActivityTime({
      users: [UUID_A],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0]).toEqual({ where: { id: expect.anything() } });
  });

  it('only the external_id branch fires when every input is non-UUID', async () => {
    const find = jest.fn().mockResolvedValue([userA]);
    const svc = makeService(makeUserRepo(find), makeMediaRepo([]));
    await svc.getActivityTime({
      users: ['919999990001'],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0]).toEqual({
      where: { external_id: expect.anything() },
    });
  });
});
