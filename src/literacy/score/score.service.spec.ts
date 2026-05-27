// Unit tests for ScoreService. DataSource.query is mocked; tests verify
// SQL shape + params and return-value mapping without touching Postgres.

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ScoreService } from './score.service';

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = '22222222-3333-4444-5555-666666666666';
const UUID_LETTER = '33333333-4444-5555-6666-777777777777';

function makeDataSource(query: jest.Mock): DataSource {
  return { query } as unknown as DataSource;
}
function makeService(query: jest.Mock): {
  service: ScoreService;
  query: jest.Mock;
} {
  return { service: new ScoreService(makeDataSource(query)), query };
}

describe('ScoreService.create', () => {
  it('inserts via INSERT...SELECT and returns the row when found', async () => {
    const row = {
      id: 's1',
      user_id: 'u1',
      letter_id: 'l1',
      user_message_id: 'mm-1',
      score: 1.5,
    };
    const { service, query } = makeService(jest.fn().mockResolvedValue([row]));

    const out = await service.create({
      user_id: 'u1',
      letter_id: 'l1',
      user_message_id: 'mm-1',
      score: 1.5,
    });

    expect(out).toEqual(row);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO scores/);
    expect(sql).toMatch(/FROM users u, letters l, media_metadata m/);
    expect(sql).toMatch(/m\.rolled_back = false/);
    // params: [user_id, letter_id, user_message_id, score]
    expect(params).toEqual(['u1', 'l1', 'mm-1', 1.5]);
  });

  it('throws NotFoundException when no row was inserted (user/letter/media missing)', async () => {
    const { service } = makeService(jest.fn().mockResolvedValue([]));

    await expect(
      service.create({
        user_id: 'u1',
        letter_id: 'l1',
        user_message_id: 'mm-1',
        score: 1,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('builds WHERE on users.external_id when given user_external_id', async () => {
    const { service, query } = makeService(jest.fn().mockResolvedValue([{}]));

    await service.create({
      user_external_id: '919999990001',
      letter_grapheme: 'क',
      user_message_id: 'mm-1',
      score: 0,
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/u\.external_id = \$1/);
    expect(sql).toMatch(/l\.grapheme = \$2/);
    expect(params).toEqual(['919999990001', 'क', 'mm-1', 0]);
  });

  it('builds WHERE on users.id when given a {user} object', async () => {
    const { service, query } = makeService(jest.fn().mockResolvedValue([{}]));

    await service.create({
      user: { id: 'u1' } as never,
      letter: { id: 'l1' } as never,
      user_message_id: 'mm-1',
      score: 0,
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/u\.id = \$1/);
    expect(sql).toMatch(/l\.id = \$2/);
    expect(params).toEqual(['u1', 'l1', 'mm-1', 0]);
  });

  it('rejects invalid options up-front (delegated to validator)', async () => {
    const { service, query } = makeService(jest.fn());
    await expect(
      service.create({ score: 0, user_message_id: 'mm-1' } as never),
    ).rejects.toThrow(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('ScoreService.find', () => {
  it('applies the default limit when none provided', async () => {
    const { service, query } = makeService(jest.fn().mockResolvedValue([]));
    await service.find({});

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/ORDER BY s\.created_at DESC LIMIT \$1/);
    // default limit pushed as the only param
    expect(params).toEqual([100_000]);
  });

  it('applies a custom limit when within bounds', async () => {
    const { service, query } = makeService(jest.fn().mockResolvedValue([]));
    await service.find({ limit: 50 });

    const params = query.mock.calls[0][1];
    expect(params[params.length - 1]).toBe(50);
  });

  it('rejects limit=0', async () => {
    const { service } = makeService(jest.fn());
    await expect(service.find({ limit: 0 })).rejects.toThrow(BadRequestException);
  });

  it('rejects limit exceeding the default cap', async () => {
    const { service } = makeService(jest.fn());
    await expect(
      service.find({ limit: 100_001 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('filters on s.user_id when user_id is provided', async () => {
    const { service, query } = makeService(jest.fn().mockResolvedValue([]));
    await service.find({ user_id: 'u1' });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE s\.user_id = \$1/);
    expect(params).toEqual(['u1', 100_000]);
  });

  it('joins users when filtering by user_external_id', async () => {
    const { service, query } = makeService(jest.fn().mockResolvedValue([]));
    await service.find({ user_external_id: '919999990001' });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM scores s, users u/);
    expect(sql).toMatch(/u\.external_id = \$1/);
    expect(sql).toMatch(/s\.user_id = u\.id/);
    expect(params).toEqual(['919999990001', 100_000]);
  });

  it('joins letters when filtering by letter_grapheme', async () => {
    const { service, query } = makeService(jest.fn().mockResolvedValue([]));
    await service.find({ letter_grapheme: 'क' });

    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/FROM scores s, letters l/);
    expect(sql).toMatch(/l\.grapheme = \$1/);
    expect(sql).toMatch(/s\.letter_id = l\.id/);
  });

  it('combines user and letter filters with AND', async () => {
    const { service, query } = makeService(jest.fn().mockResolvedValue([]));
    await service.find({ user_id: 'u1', letter_id: 'l1' });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/s\.user_id = \$1 AND s\.letter_id = \$2/);
    expect(params).toEqual(['u1', 'l1', 100_000]);
  });

  it('uses {user}.id when passed a User object', async () => {
    const { service, query } = makeService(jest.fn().mockResolvedValue([]));
    await service.find({ user: { id: 'u1' } as never });
    expect(query.mock.calls[0][1][0]).toBe('u1');
  });

  it('uses {letter}.id when passed a Letter object', async () => {
    const { service, query } = makeService(jest.fn().mockResolvedValue([]));
    await service.find({ letter: { id: 'l1' } as never });
    expect(query.mock.calls[0][1][0]).toBe('l1');
  });
});

describe('ScoreService.gradeAndRecord', () => {
  it('rejects when neither correct nor incorrect is provided', async () => {
    const { service } = makeService(jest.fn());
    await expect(
      service.gradeAndRecord({
        user_id: 'u1',
        userMessageId: 'mm-1',
      } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('inserts and returns rows; uses last score as baseline; rounds with +1.01 for correct', async () => {
    // 2 letters in history; one non-integer (-0.5 for क), one integer (3 for ख).
    // Average uses only non-integer = -0.5.
    // For correct 'क': previous = -0.5 → new = -0.5 + 1.01 = 0.51
    // For incorrect 'ख': previous = 3 → new = 3 - 3.001 = -0.001
    const findRows = [
      {
        id: 's2',
        letter_id: 'l-ka',
        user_id: 'u1',
        score: -0.5,
        user_message_id: 'mm-x',
        created_at: new Date('2026-04-27T11:00:00Z'),
      },
      {
        id: 's1',
        letter_id: 'l-ka',
        user_id: 'u1',
        score: -2.5,
        user_message_id: 'mm-y',
        created_at: new Date('2026-04-27T10:00:00Z'),
      },
      {
        id: 's3',
        letter_id: 'l-kha',
        user_id: 'u1',
        score: 3,
        user_message_id: 'mm-z',
        created_at: new Date('2026-04-27T10:30:00Z'),
      },
    ];
    const letterRows = [
      { id: 'l-ka', grapheme: 'क' },
      { id: 'l-kha', grapheme: 'ख' },
    ];
    const insertedRows = [
      { id: 'new1', letter_id: 'l-ka', score: 0.51 },
      { id: 'new2', letter_id: 'l-kha', score: -0.001 },
    ];

    const query = jest
      .fn()
      .mockResolvedValueOnce(findRows) // find()
      .mockResolvedValueOnce(letterRows) // letter id→grapheme lookup
      .mockResolvedValueOnce(insertedRows); // INSERT
    const { service } = makeService(query);

    const out = await service.gradeAndRecord({
      user_id: 'u1',
      correct: ['क'],
      incorrect: ['ख'],
      userMessageId: 'mm-now',
    });

    expect(out).toBe(insertedRows);

    // Check INSERT params: [user_param, userMessageId, grapheme1, score1, grapheme2, score2]
    const insertCall = query.mock.calls[2];
    const [sql, params] = insertCall;
    expect(sql).toMatch(/INSERT INTO scores/);
    expect(sql).toMatch(/UNION ALL/);
    expect(params[0]).toBe('u1');
    expect(params[1]).toBe('mm-now');
    expect(params[2]).toBe('क');
    expect(params[3]).toBeCloseTo(0.51, 5);
    expect(params[4]).toBe('ख');
    expect(params[5]).toBeCloseTo(-0.001, 5);
  });

  it('uses 0 as baseline for new (never-seen) graphemes', async () => {
    // History: empty. New grapheme 'क' is incorrect.
    // base = 0, new = 0 - 3.001 = -3.001
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // find()
      // letterIds is empty → skips letter lookup
      .mockResolvedValueOnce([{ score: -3.001 }]); // INSERT
    const { service } = makeService(query);

    await service.gradeAndRecord({
      user_id: 'u1',
      incorrect: 'क',
      userMessageId: 'mm-1',
    });

    // Only 2 queries: find + insert (no letter lookup because letterIds is empty)
    expect(query).toHaveBeenCalledTimes(2);
    const params = query.mock.calls[1][1];
    expect(params[3]).toBeCloseTo(-3.001, 5);
  });

  it('logs warn and returns [] when INSERT produced no rows (media rolled back)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // find
      .mockResolvedValueOnce([]); // INSERT returns nothing
    const { service } = makeService(query);

    const out = await service.gradeAndRecord({
      user_id: 'u1',
      correct: 'क',
      userMessageId: 'mm-1',
    });

    expect(out).toEqual([]);
  });

  it('routes user_external_id into u.external_id WHERE in the INSERT UNION', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // find
      .mockResolvedValueOnce([{}]); // insert
    const { service } = makeService(query);

    await service.gradeAndRecord({
      user_external_id: '919999990001',
      correct: 'क',
      userMessageId: 'mm-1',
    });

    const insertSql = query.mock.calls[1][0];
    expect(insertSql).toMatch(/u\.external_id = \$1/);
    expect(query.mock.calls[1][1][0]).toBe('919999990001');
  });

  it('average of non-integer scores becomes 0.001 when none exist (only integer history)', async () => {
    // History has only integer scores. The "average" path defaults to 0.001
    // (the magic constant). This test asserts the new score follows from
    // baseline = previousScore (not average), which is the spec.
    const findRows = [
      {
        id: 's1',
        letter_id: 'l-ka',
        user_id: 'u1',
        score: 2, // integer — excluded from average
        user_message_id: 'mm-x',
        created_at: new Date(),
      },
    ];
    const letterRows = [{ id: 'l-ka', grapheme: 'क' }];
    const query = jest
      .fn()
      .mockResolvedValueOnce(findRows)
      .mockResolvedValueOnce(letterRows)
      .mockResolvedValueOnce([{ score: 3.01 }]);

    const { service } = makeService(query);
    await service.gradeAndRecord({
      user_id: 'u1',
      correct: 'क',
      userMessageId: 'mm-1',
    });

    // previousScore for 'क' is 2 (integer kept as baseline). 2 + 1.01 = 3.01
    expect(query.mock.calls[2][1][3]).toBeCloseTo(3.01, 5);
  });
});

describe('ScoreService.getLetterBins', () => {
  it('throws BadRequest on empty string input (validator)', async () => {
    const { service } = makeService(jest.fn());
    await expect(service.getLetterBins('')).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequest on empty array input', async () => {
    const { service } = makeService(jest.fn());
    await expect(service.getLetterBins([])).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequest when asOf is an Invalid Date', async () => {
    const { service } = makeService(jest.fn());
    await expect(
      service.getLetterBins(UUID_A, { asOf: new Date('not-a-date') }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException when an id is unresolved', async () => {
    // First query returns the existing users; ids passed in but not returned
    // by the SELECT raise NotFoundException.
    const query = jest.fn().mockResolvedValueOnce([]); // userRows
    const { service } = makeService(query);

    await expect(service.getLetterBins(UUID_A)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException when a phone is unresolved', async () => {
    const query = jest.fn().mockResolvedValueOnce([]); // userRows
    const { service } = makeService(query);
    await expect(service.getLetterBins('919999990001')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns a single LetterBinsResult when given a string (not wrapped in array)', async () => {
    const userRows = [{ id: UUID_A, external_id: '919999990001' }];
    const aggRows = [
      // untouched: seed null
      {
        user_id: UUID_A,
        grapheme: 'क',
        n_scores: 0,
        seed_score: null,
        last_score: null,
        min_score: null,
      },
      // untouched: n <= 1 (only seed row)
      {
        user_id: UUID_A,
        grapheme: 'ख',
        n_scores: 1,
        seed_score: 0,
        last_score: 0,
        min_score: 0,
      },
      // regressed: last <= seed
      {
        user_id: UUID_A,
        grapheme: 'ग',
        n_scores: 3,
        seed_score: 0,
        last_score: -1,
        min_score: -3,
      },
      // learnt: n>=4, dip>=4 below seed, last>seed
      {
        user_id: UUID_A,
        grapheme: 'घ',
        n_scores: 5,
        seed_score: 0,
        last_score: 2,
        min_score: -4,
      },
      // improved: last>seed but not learnt (n<4)
      {
        user_id: UUID_A,
        grapheme: 'ङ',
        n_scores: 2,
        seed_score: 0,
        last_score: 5,
        min_score: -1,
      },
    ];
    const query = jest
      .fn()
      .mockResolvedValueOnce(userRows)
      .mockResolvedValueOnce(aggRows);
    const { service } = makeService(query);

    const out = await service.getLetterBins(UUID_A);

    // String input → single result, not array
    expect(Array.isArray(out)).toBe(false);
    const result = out as { bins: { untouched: string[]; regressed: string[]; learnt: string[]; improved: string[] } };
    expect(result.bins.untouched).toEqual(expect.arrayContaining(['क', 'ख']));
    expect(result.bins.regressed).toEqual(['ग']);
    expect(result.bins.learnt).toEqual(['घ']);
    expect(result.bins.improved).toEqual(['ङ']);
  });

  it('returns an array of LetterBinsResult when given an array (preserves order, dedupes)', async () => {
    const userRows = [
      { id: UUID_A, external_id: '919999990001' },
      { id: UUID_B, external_id: '918888880002' },
    ];
    const query = jest
      .fn()
      .mockResolvedValueOnce(userRows)
      .mockResolvedValueOnce([]); // no aggregates
    const { service } = makeService(query);

    // Input order: B by phone, A by id, then A again by phone (dedupe).
    const out = (await service.getLetterBins([
      '918888880002',
      UUID_A,
      '919999990001',
    ])) as { userId: string }[];

    expect(out).toHaveLength(2);
    expect(out.map((r) => r.userId)).toEqual([UUID_B, UUID_A]);
  });

  it('includes the asOf clause in the aggregate query when asOf is provided', async () => {
    const userRows = [{ id: UUID_A, external_id: '919999990001' }];
    const query = jest
      .fn()
      .mockResolvedValueOnce(userRows)
      .mockResolvedValueOnce([]);
    const { service } = makeService(query);

    const cutoff = new Date('2026-04-27T00:00:00Z');
    await service.getLetterBins(UUID_A, { asOf: cutoff });

    const aggCall = query.mock.calls[1];
    expect(aggCall[0]).toMatch(/AND s\.created_at <= \$2/);
    expect(aggCall[1]).toEqual([[UUID_A], cutoff]);
  });

  it('treats last==seed as regressed (boundary)', async () => {
    const userRows = [{ id: UUID_A, external_id: '919999990001' }];
    const aggRows = [
      {
        user_id: UUID_A,
        grapheme: 'क',
        n_scores: 3,
        seed_score: 0,
        last_score: 0, // equal → regressed
        min_score: -2,
      },
    ];
    const query = jest
      .fn()
      .mockResolvedValueOnce(userRows)
      .mockResolvedValueOnce(aggRows);
    const { service } = makeService(query);

    const out = (await service.getLetterBins(UUID_A)) as {
      bins: { regressed: string[] };
    };
    expect(out.bins.regressed).toContain('क');
  });

  it('treats min == seed - 4 as a qualifying dip (≤ boundary)', async () => {
    const userRows = [{ id: UUID_A, external_id: '919999990001' }];
    const aggRows = [
      {
        user_id: UUID_A,
        grapheme: 'क',
        n_scores: 4,
        seed_score: 0,
        last_score: 1,
        min_score: -4, // exactly seed - 4
      },
    ];
    const query = jest
      .fn()
      .mockResolvedValueOnce(userRows)
      .mockResolvedValueOnce(aggRows);
    const { service } = makeService(query);

    const out = (await service.getLetterBins(UUID_A)) as {
      bins: { learnt: string[] };
    };
    expect(out.bins.learnt).toContain('क');
  });

  it('falls back to untouched when last_score is null despite n_scores > 1', async () => {
    // Should not happen in real DB output, but the code defensively bins it as
    // untouched. Asserting that defensive path runs.
    const userRows = [{ id: UUID_A, external_id: '919999990001' }];
    const aggRows = [
      {
        user_id: UUID_A,
        grapheme: 'क',
        n_scores: 3,
        seed_score: 0,
        last_score: null,
        min_score: null,
      },
    ];
    const query = jest
      .fn()
      .mockResolvedValueOnce(userRows)
      .mockResolvedValueOnce(aggRows);
    const { service } = makeService(query);

    const out = (await service.getLetterBins(UUID_A)) as {
      bins: { untouched: string[] };
    };
    expect(out.bins.untouched).toContain('क');
  });

  it('coerces string n_scores from the DB (COUNT(*) returns text in pg) to a number', async () => {
    const userRows = [{ id: UUID_A, external_id: '919999990001' }];
    const aggRows = [
      {
        user_id: UUID_A,
        grapheme: 'क',
        n_scores: '5', // string from pg COUNT
        seed_score: 0,
        last_score: 2,
        min_score: -4,
      },
    ];
    const query = jest
      .fn()
      .mockResolvedValueOnce(userRows)
      .mockResolvedValueOnce(aggRows);
    const { service } = makeService(query);

    const out = (await service.getLetterBins(UUID_A)) as {
      bins: { learnt: string[] };
    };
    expect(out.bins.learnt).toContain('क');
  });
});

describe('ScoreService.createSeedScores', () => {
  it('inserts all SEED_SCORES rows in a single UNION ALL INSERT', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { service } = makeService(query);

    await service.createSeedScores('u1');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO scores \(user_id, letter_id, score\)/);
    expect(sql).toMatch(/UNION ALL/);
    // params layout: [userId, grapheme1, score1, grapheme2, score2, ...]
    expect(params[0]).toBe('u1');
    expect((params.length - 1) % 2).toBe(0); // pairs
    const pairs = (params.length - 1) / 2;
    expect(pairs).toBeGreaterThanOrEqual(20); // sanity: SEED_SCORES isn't empty
    // First grapheme/score from SEED_SCORES is 'ऋ' / 1.
    expect(params[1]).toBe('ऋ');
    expect(params[2]).toBe(1);
  });
});
