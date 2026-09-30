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

// getTodayActiveTime reads one SQL aggregate (one row per active IST day);
// the gap rule lives in that SQL, so these tests feed day rows and pin the
// derivations plus the query's filters and parameters.
type DayRow = { date: string; active_ms: string; latest_gap_ms: string };

function day(date: string, activeMs: number, latestGapMs = 0): DayRow {
  return {
    date,
    active_ms: String(activeMs),
    latest_gap_ms: String(latestGapMs),
  };
}

function makeDayRepo(rows: DayRow[]): {
  createQueryBuilder: jest.Mock;
  manager: { query: jest.Mock };
} {
  return {
    createQueryBuilder: jest.fn(),
    manager: { query: jest.fn().mockResolvedValue(rows) },
  };
}

const MIN = 60_000;

describe('UserActivityService.getTodayActiveTime', () => {
  beforeEach(() => {
    // 2026-05-15T06:30Z = 12:00 IST on 2026-05-15.
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T06:30:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns all zeros when the user has no voice messages', async () => {
    const svc = makeService(makeUserRepo(jest.fn()), makeDayRepo([]));

    await expect(svc.getTodayActiveTime(UUID_A)).resolves.toEqual({
      withLatestTurn: 0,
      withoutLatestTurn: 0,
      totalWithLatestTurn: 0,
      totalWithoutLatestTurn: 0,
      priorStreakDays: 0,
    });
  });

  it("returns today's active ms including and excluding the latest turn", async () => {
    // Today holds 306s, of which the latest message added 51s: a caller
    // checking the 5-min threshold sees 255_000 < 300_000 <= 306_000.
    const svc = makeService(
      makeUserRepo(jest.fn()),
      makeDayRepo([day('2026-05-15', 306_000, 51_000)]),
    );

    await expect(svc.getTodayActiveTime(UUID_A)).resolves.toEqual({
      withLatestTurn: 306_000,
      withoutLatestTurn: 255_000,
      totalWithLatestTurn: 306_000,
      totalWithoutLatestTurn: 255_000,
      priorStreakDays: 0,
    });
  });

  it('a latest turn that added nothing leaves with === without', async () => {
    const svc = makeService(
      makeUserRepo(jest.fn()),
      makeDayRepo([day('2026-05-15', 300_000, 0)]),
    );

    const result = await svc.getTodayActiveTime(UUID_A);
    expect(result.withLatestTurn).toBe(300_000);
    expect(result.withoutLatestTurn).toBe(300_000);
    expect(result.totalWithoutLatestTurn).toBe(300_000);
  });

  it('sums EVERY day into the total, including days under the streak minimum', async () => {
    const svc = makeService(
      makeUserRepo(jest.fn()),
      makeDayRepo([
        day('2026-05-01', 1 * MIN, 10_000),
        day('2026-05-10', 40 * MIN, 20_000),
        day('2026-05-15', 2 * MIN, 30_000),
      ]),
    );

    const result = await svc.getTodayActiveTime(UUID_A);
    expect(result.totalWithLatestTurn).toBe(43 * MIN);
    // Only the LAST row's latest gap is the current turn's contribution.
    expect(result.totalWithoutLatestTurn).toBe(43 * MIN - 30_000);
    expect(result.withLatestTurn).toBe(2 * MIN);
    expect(result.withoutLatestTurn).toBe(2 * MIN - 30_000);
  });

  it("reports 0/0 for today when the latest message is on an earlier day, and never subtracts its gap from today's value", async () => {
    const svc = makeService(
      makeUserRepo(jest.fn()),
      makeDayRepo([day('2026-05-14', 10 * MIN, 45_000)]),
    );

    await expect(svc.getTodayActiveTime(UUID_A)).resolves.toEqual({
      withLatestTurn: 0,
      withoutLatestTurn: 0,
      totalWithLatestTurn: 10 * MIN,
      totalWithoutLatestTurn: 10 * MIN - 45_000,
      priorStreakDays: 1,
    });
  });

  it('counts consecutive qualifying days immediately before today as the prior streak', async () => {
    const svc = makeService(
      makeUserRepo(jest.fn()),
      makeDayRepo([
        day('2026-05-12', 6 * MIN),
        day('2026-05-13', 7 * MIN),
        day('2026-05-14', 8 * MIN),
        day('2026-05-15', 1 * MIN, 30_000),
      ]),
    );

    expect((await svc.getTodayActiveTime(UUID_A)).priorStreakDays).toBe(3);
  });

  it('does not count today towards the prior streak, however active', async () => {
    const svc = makeService(
      makeUserRepo(jest.fn()),
      makeDayRepo([day('2026-05-15', 30 * MIN, 30_000)]),
    );

    expect((await svc.getTodayActiveTime(UUID_A)).priorStreakDays).toBe(0);
  });

  it('breaks the streak at a day with no activity', async () => {
    const svc = makeService(
      makeUserRepo(jest.fn()),
      makeDayRepo([
        day('2026-05-11', 9 * MIN),
        // 2026-05-12 missing
        day('2026-05-13', 9 * MIN),
        day('2026-05-14', 9 * MIN),
      ]),
    );

    expect((await svc.getTodayActiveTime(UUID_A)).priorStreakDays).toBe(2);
  });

  it('breaks the streak when yesterday is missing even if earlier days qualify', async () => {
    const svc = makeService(
      makeUserRepo(jest.fn()),
      makeDayRepo([day('2026-05-12', 9 * MIN), day('2026-05-13', 9 * MIN)]),
    );

    expect((await svc.getTodayActiveTime(UUID_A)).priorStreakDays).toBe(0);
  });

  it('a day of EXACTLY 5 minutes counts towards the streak; 1 ms less breaks it (>= not >)', async () => {
    const svc = makeService(
      makeUserRepo(jest.fn()),
      makeDayRepo([
        day('2026-05-12', 20 * MIN),
        day('2026-05-13', 5 * MIN - 1),
        day('2026-05-14', 5 * MIN),
      ]),
    );

    expect((await svc.getTodayActiveTime(UUID_A)).priorStreakDays).toBe(1);
  });

  it('walks a streak across a month boundary', async () => {
    jest.setSystemTime(new Date('2026-06-02T06:30:00Z'));
    const svc = makeService(
      makeUserRepo(jest.fn()),
      makeDayRepo([
        day('2026-05-30', 5 * MIN),
        day('2026-05-31', 5 * MIN),
        day('2026-06-01', 5 * MIN),
      ]),
    );

    expect((await svc.getTodayActiveTime(UUID_A)).priorStreakDays).toBe(3);
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
    // Activity events = live voice notes + flow taps (active-time.ts).
    expect(qb.addSelect).toHaveBeenCalledWith(
      "(mm.media_type = 'text')",
      'tap',
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      "mm.source = 'whatsapp' AND (mm.media_type = 'audio' OR (mm.media_type = 'text' AND mm.media_details->>'nfm_reply' = 'true')) AND mm.rolled_back = false",
    );
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

  it('a gap ending in a flow tap gets the 298 s allowance; the same gap ending in a voice note is a break', async () => {
    const userRepo = makeUserRepo(jest.fn().mockResolvedValue([userA]));
    const rows = [
      { user_id: UUID_A, created_at: new Date('2026-04-27T09:00:00Z') },
      // +200 s, a tap: the student was reading the passage in the flow ✓
      {
        user_id: UUID_A,
        created_at: new Date('2026-04-27T09:03:20Z'),
        tap: true,
      },
      // +200 s, a voice note: over the 120 s voice allowance ✗
      { user_id: UUID_A, created_at: new Date('2026-04-27T09:06:40Z') },
      // +298 s exactly, a tap: the allowance is strict ✗
      {
        user_id: UUID_A,
        created_at: new Date('2026-04-27T09:11:38Z'),
        tap: true,
      },
    ];
    const svc = makeService(userRepo, makeMediaRepo(rows));
    const out = await svc.getActivityTime({
      users: [UUID_A],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(out.results[0].windows[0].active_ms).toBe(200_000);
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

describe('UserActivityService.getTodayActiveTime — IST day + query shape', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('treats 23:30 IST as still the same IST day', async () => {
    // 2026-05-15T18:00Z = 23:30 IST on 2026-05-15.
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T18:00:00Z'));
    const svc = makeService(
      makeUserRepo(jest.fn()),
      makeDayRepo([
        day('2026-05-14', 6 * MIN),
        day('2026-05-15', 4 * MIN, 50_000),
      ]),
    );

    await expect(svc.getTodayActiveTime(UUID_A)).resolves.toEqual({
      withLatestTurn: 4 * MIN,
      withoutLatestTurn: 4 * MIN - 50_000,
      totalWithLatestTurn: 10 * MIN,
      totalWithoutLatestTurn: 10 * MIN - 50_000,
      priorStreakDays: 1,
    });
  });

  it('rolls "today" over at IST midnight, not UTC midnight', async () => {
    // 2026-05-15T18:30Z = 00:00 IST on 2026-05-16 (still the 15th in UTC).
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T18:30:00Z'));
    const svc = makeService(
      makeUserRepo(jest.fn()),
      makeDayRepo([
        day('2026-05-14', 6 * MIN),
        day('2026-05-15', 7 * MIN, 50_000),
      ]),
    );

    await expect(svc.getTodayActiveTime(UUID_A)).resolves.toEqual({
      withLatestTurn: 0,
      withoutLatestTurn: 0,
      totalWithLatestTurn: 13 * MIN,
      totalWithoutLatestTurn: 13 * MIN - 50_000,
      priorStreakDays: 2,
    });
  });

  it('runs exactly one query, scoped to the user, with the visibility filters and the 120s / 298s gap rule', async () => {
    const mediaRepo = makeDayRepo([]);
    const svc = makeService(makeUserRepo(jest.fn()), mediaRepo);
    await svc.getTodayActiveTime(UUID_A);

    expect(mediaRepo.manager.query).toHaveBeenCalledTimes(1);
    expect(mediaRepo.createQueryBuilder).not.toHaveBeenCalled();
    const [sql, params] = mediaRepo.manager.query.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(params).toEqual([UUID_A]);
    expect(sql).toContain('user_id = $1');
    expect(sql).toContain("source = 'whatsapp'");
    // voice notes AND comprehension flow taps
    expect(sql).toContain(
      "(media_type = 'audio' OR (media_type = 'text' AND media_details->>'nfm_reply' = 'true'))",
    );
    expect(sql).toContain('rolled_back = false');
    expect(sql).toContain("(media_type = 'text') AS is_tap");
    // a gap ending in a tap gets the 4 min 58 s passage-read allowance
    expect(sql).toContain(
      'gap_ms > 0 AND gap_ms < CASE WHEN is_tap THEN 298000 ELSE 120000 END',
    );
    expect(sql).toContain('prev_ist_date = ist_date');
    expect(sql).toContain("interval '330 minutes'");
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
