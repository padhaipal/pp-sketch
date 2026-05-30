// Unit tests for ScoreService. DataSource.query is mocked; tests verify
// SQL shape + params and return-value mapping without touching Postgres.

// uuid is ESM-only — provide a CJS-shaped mock. validate uses the loose
// hex-shape regex (no version/variant nibble checks) so test fixtures with
// arbitrary hex bytes still classify as uuids.
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'gen-uuid'),
  validate: (s: unknown): boolean =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ScoreService } from './score.service';

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = '22222222-3333-4444-5555-666666666666';
const _UUID_LETTER = '33333333-4444-5555-6666-777777777777';

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
    await expect(service.find({ limit: 0 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects limit exceeding the default cap', async () => {
    const { service } = makeService(jest.fn());
    await expect(service.find({ limit: 100_001 })).rejects.toThrow(
      BadRequestException,
    );
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
    await expect(service.getLetterBins('')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('throws BadRequest on empty array input', async () => {
    const { service } = makeService(jest.fn());
    await expect(service.getLetterBins([])).rejects.toThrow(
      BadRequestException,
    );
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

  it('throws BadRequestException without hitting the DB when an identifier is malformed (not uuid, not valid E.164)', async () => {
    const query = jest.fn();
    const { service } = makeService(query);
    await expect(service.getLetterBins('garbage-input')).rejects.toThrow(
      BadRequestException,
    );
    expect(query).not.toHaveBeenCalled();
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
    const result = out as {
      bins: {
        untouched: string[];
        regressed: string[];
        learnt: string[];
        improved: string[];
      };
    };
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

// ─── mutation hardening ──────────────────────────────────────────────────────
// Tightens SQL/param/boundary assertions so Stryker mutants are killed:
//   - exact $N placeholders (kills idx++ UpdateOperator + i+1/idx+i arithmetic)
//   - SQL clause fragments (kills the template-literal StringLiteral mutants)
//   - the full SEED_SCORES param sequence (kills the 54 ObjectLiteral mutants)
//   - bin-classification boundaries (kills the getLetterBins conditionals)
//   - exact calculateNewScore deltas (+1.01 / -3.001)
//   - exact thrown-exception messages

// SEED_SCORES mirror — kept in lockstep with score.service.ts. A change there
// without a change here should fail this test (that's the point).
const SEED_PAIRS: [string, number][] = [
  ['ऋ', 1],
  ['ा', 1.5],
  ['ी', 2],
  ['ु', 2.5],
  ['े', 3],
  ['ो', 3.5],
  ['ै', 4],
  ['ू', 4.5],
  ['ौ', 5],
  ['ि', 5.5],
  ['ं', 6],
  ['ृ', 6.5],
  ['ञ', 7],
  ['ण', 7],
  ['अ', 0],
  ['आ', 0],
  ['इ', 0],
  ['ई', 0],
  ['उ', 0],
  ['ऊ', 0],
  ['ए', 0],
  ['ऐ', 0],
  ['ओ', 0],
  ['औ', 0],
  ['क', 0],
  ['ख', 0],
  ['ग', 0],
  ['घ', 0],
  ['च', 0],
  ['छ', 0],
  ['ज', 0],
  ['झ', 0],
  ['ट', 0],
  ['ठ', 0],
  ['ड', 0],
  ['ढ', 0],
  ['त', 0],
  ['थ', 0],
  ['द', 0],
  ['ध', 0],
  ['न', 0],
  ['प', 0],
  ['फ', 0],
  ['ब', 0],
  ['भ', 0],
  ['म', 0],
  ['य', 0],
  ['र', 0],
  ['ल', 0],
  ['व', 0],
  ['श', 0],
  ['ष', 0],
  ['स', 0],
  ['ह', 0],
];

function userRow(id: string, external_id = '919999990001') {
  return { id, external_id };
}

describe('ScoreService.create — exact SQL placeholders + clauses', () => {
  it('numbers the user/letter/message/score placeholders $1..$4 in order', async () => {
    const { service, query } = makeService(
      jest.fn().mockResolvedValue([{ id: 's1' }]),
    );
    await service.create({
      user_id: 'u1',
      letter_id: 'l1',
      user_message_id: 'mm-1',
      score: 1.5,
    });
    const sql: string = query.mock.calls[0][0];
    expect(sql).toContain('u.id = $1');
    expect(sql).toContain('l.id = $2');
    // umIdx=$3, scoreIdx=$4 (kills the idx++ → idx-- + nextIdx +1 → -1 mutants).
    expect(sql).toContain('$3, $4');
    expect(sql).toContain('m.id = $3 AND m.rolled_back = false');
    expect(sql).toContain(
      'INSERT INTO scores (user_id, letter_id, user_message_id, score)',
    );
    expect(sql).toContain('RETURNING *');
  });

  it('throws the exact NotFound message when the insert matches nothing', async () => {
    const { service } = makeService(jest.fn().mockResolvedValue([]));
    await expect(
      service.create({
        user_id: 'u1',
        letter_id: 'l1',
        user_message_id: 'mm-1',
        score: 0,
      }),
    ).rejects.toThrow(
      'create() referenced user, letter, or media_metadata not found (or rolled back)',
    );
  });
});

describe('ScoreService.find — exact placeholder numbering', () => {
  it('numbers user=$1, letter=$2, limit=$3 when both filters are present', async () => {
    const { service, query } = makeService(jest.fn().mockResolvedValue([]));
    await service.find({ user_id: 'u1', letter_id: 'l1' });
    const sql: string = query.mock.calls[0][0];
    expect(sql).toContain('s.user_id = $1 AND s.letter_id = $2');
    expect(sql).toContain('LIMIT $3'); // kills idx++ → idx-- on the limit placeholder
    expect(sql).toContain('ORDER BY s.created_at DESC');
  });

  it('omits the WHERE clause entirely when no filters are given (kills the >0 ternary)', async () => {
    const { service, query } = makeService(jest.fn().mockResolvedValue([]));
    await service.find({});
    const sql: string = query.mock.calls[0][0];
    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('LIMIT $1');
  });

  it('rejects a non-positive limit with the exact message', async () => {
    const { service } = makeService(jest.fn());
    await expect(service.find({ limit: 0 })).rejects.toThrow(
      'find() options.limit must be a positive integer',
    );
  });

  it('rejects a limit over the cap with the exact message', async () => {
    const { service } = makeService(jest.fn());
    await expect(service.find({ limit: 100_001 })).rejects.toThrow(
      'find() options.limit must not exceed 100000',
    );
  });
});

describe('ScoreService.gradeAndRecord — placeholders + score math', () => {
  it('builds the letter-id lookup with a $1 placeholder (kills i+1 → i-1)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 's1',
          letter_id: 'l-ka',
          user_id: 'u1',
          score: 0.5,
          user_message_id: 'mm-x',
          created_at: new Date(),
        },
      ])
      .mockResolvedValueOnce([{ id: 'l-ka', grapheme: 'क' }])
      .mockResolvedValueOnce([{ id: 'new1' }]);
    const { service } = makeService(query);
    await service.gradeAndRecord({
      user_id: 'u1',
      correct: 'क',
      userMessageId: 'mm-1',
    });
    const letterSql: string = query.mock.calls[1][0];
    expect(letterSql).toContain(
      'SELECT id, grapheme FROM letters WHERE id IN ($1)',
    );
  });

  it('numbers the INSERT-UNION grapheme=$3 / score=$4 placeholders (kills idx+1 → idx-1)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // find → no history
      .mockResolvedValueOnce([{ id: 'new1' }]); // insert
    const { service } = makeService(query);
    await service.gradeAndRecord({
      user_id: 'u1',
      correct: 'क',
      userMessageId: 'mm-1',
    });
    const insertSql: string = query.mock.calls[1][0];
    expect(insertSql).toContain('l.grapheme = $3');
    expect(insertSql).toContain('$4::double precision AS score');
    expect(insertSql).toContain('m.id = $2 AND m.rolled_back = false');
    expect(insertSql).toContain(
      'INSERT INTO scores (user_id, letter_id, user_message_id, score)',
    );
  });

  it('applies +1.01 for a correct answer off a 0 baseline (exact)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // no history → baseline 0
      .mockResolvedValueOnce([{ id: 'new1' }]);
    const { service } = makeService(query);
    await service.gradeAndRecord({
      user_id: 'u1',
      correct: 'क',
      userMessageId: 'mm-1',
    });
    const params = query.mock.calls[1][1];
    // params: [userParam, userMessageId, grapheme, score]
    expect(params[2]).toBe('क');
    expect(params[3]).toBeCloseTo(1.01, 5);
  });

  it('applies -3.001 for an incorrect answer off a 0 baseline (exact)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'new1' }]);
    const { service } = makeService(query);
    await service.gradeAndRecord({
      user_id: 'u1',
      incorrect: 'क',
      userMessageId: 'mm-1',
    });
    const params = query.mock.calls[1][1];
    expect(params[3]).toBeCloseTo(-3.001, 5);
  });

  it('uses the latest per-letter score as the baseline (kills the reviewed %1 detection + average)', async () => {
    // History: क last score 2.01 (non-integer → "reviewed"). correct → 2.01 + 1.01 = 3.02.
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 's2',
          letter_id: 'l-ka',
          user_id: 'u1',
          score: 2.01,
          user_message_id: 'm2',
          created_at: new Date('2026-01-02'),
        },
        {
          id: 's1',
          letter_id: 'l-ka',
          user_id: 'u1',
          score: 0.5,
          user_message_id: 'm1',
          created_at: new Date('2026-01-01'),
        },
      ])
      .mockResolvedValueOnce([{ id: 'l-ka', grapheme: 'क' }])
      .mockResolvedValueOnce([{ id: 'new1' }]);
    const { service } = makeService(query);
    await service.gradeAndRecord({
      user_id: 'u1',
      correct: 'क',
      userMessageId: 'mm-1',
    });
    const params = query.mock.calls[2][1];
    expect(params[3]).toBeCloseTo(3.02, 5);
  });

  it('returns [] when the INSERT yields no rows (rolled-back media)', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const { service } = makeService(query);
    await expect(
      service.gradeAndRecord({
        user_id: 'u1',
        correct: 'क',
        userMessageId: 'mm-1',
      }),
    ).resolves.toEqual([]);
  });
});

describe('ScoreService.getLetterBins — resolution SQL + aggregate clauses', () => {
  it('numbers id placeholders $1..$N and uses id IN (...) for UUID inputs', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([userRow(UUID_A), userRow(UUID_B, '918888880002')])
      .mockResolvedValueOnce([]);
    const { service } = makeService(query);
    await service.getLetterBins([UUID_A, UUID_B]);
    const userSql: string = query.mock.calls[0][0];
    expect(userSql).toContain('id IN ($1,$2)'); // kills idx+i → idx-i
    expect(userSql).toContain('SELECT id, external_id FROM users WHERE');
  });

  it('uses external_id IN (...) for phone inputs', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([userRow(UUID_A, '919999990001')])
      .mockResolvedValueOnce([]);
    const { service } = makeService(query);
    await service.getLetterBins(['919999990001']);
    expect(query.mock.calls[0][0]).toContain('external_id IN ($1)');
  });

  it('emits the documented aggregate CTE clauses', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([userRow(UUID_A)])
      .mockResolvedValueOnce([]);
    const { service } = makeService(query);
    await service.getLetterBins(UUID_A);
    const aggSql: string = query.mock.calls[1][0];
    expect(aggSql).toContain('s.user_id = ANY($1::uuid[])');
    expect(aggSql).toContain(
      'MAX(score) FILTER (WHERE user_message_id IS NULL) AS seed_score',
    );
    expect(aggSql).toContain(
      'MAX(score) FILTER (WHERE rn_last = 1) AS last_score',
    );
    expect(aggSql).toContain('MIN(score) AS min_score');
    expect(aggSql).toContain('CROSS JOIN letters l');
    expect(aggSql).toContain(
      'LEFT JOIN agg a ON a.user_id = u.id AND a.letter_id = l.id',
    );
  });

  it('throws the exact NotFound message for an unresolved id', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const { service } = makeService(query);
    await expect(service.getLetterBins(UUID_A)).rejects.toThrow(
      `User not found: ${UUID_A}`,
    );
  });

  it('throws the exact BadRequest message for an invalid asOf', async () => {
    const { service } = makeService(jest.fn());
    await expect(
      service.getLetterBins(UUID_A, { asOf: new Date('nope') }),
    ).rejects.toThrow('getLetterBins() options.asOf must be a valid Date');
  });
});

describe('ScoreService.getLetterBins — bin classification boundaries', () => {
  function bins(agg: Record<string, unknown>) {
    const query = jest
      .fn()
      .mockResolvedValueOnce([userRow(UUID_A)])
      .mockResolvedValueOnce([{ user_id: UUID_A, grapheme: 'क', ...agg }]);
    return makeService(query).service.getLetterBins(UUID_A) as Promise<{
      bins: {
        untouched: string[];
        regressed: string[];
        learnt: string[];
        improved: string[];
      };
    }>;
  }

  it('n_scores=1 → untouched (boundary of n <= 1)', async () => {
    const out = await bins({
      n_scores: 1,
      seed_score: 0,
      last_score: 0,
      min_score: 0,
    });
    expect(out.bins.untouched).toContain('क');
  });

  it('n_scores=2 with last>seed and shallow dip → NOT untouched (improved)', async () => {
    const out = await bins({
      n_scores: 2,
      seed_score: 0,
      last_score: 1,
      min_score: -1,
    });
    expect(out.bins.untouched).not.toContain('क');
    expect(out.bins.improved).toContain('क');
  });

  it('seed_score=null → untouched even with scores present', async () => {
    const out = await bins({
      n_scores: 3,
      seed_score: null,
      last_score: 2,
      min_score: -2,
    });
    expect(out.bins.untouched).toContain('क');
  });

  it('last==seed → regressed; last just above seed → not regressed', async () => {
    const eq = await bins({
      n_scores: 3,
      seed_score: 0,
      last_score: 0,
      min_score: -1,
    });
    expect(eq.bins.regressed).toContain('क');
    const above = await bins({
      n_scores: 3,
      seed_score: 0,
      last_score: 0.01,
      min_score: -1,
    });
    expect(above.bins.regressed).not.toContain('क');
  });

  it('learnt requires BOTH n>=4 AND a dip of at least 4 below seed', async () => {
    // n=4, min=seed-4 exactly, last>seed → learnt.
    const learnt = await bins({
      n_scores: 4,
      seed_score: 0,
      last_score: 2,
      min_score: -4,
    });
    expect(learnt.bins.learnt).toContain('क');
    // n=3 (too few) → improved, not learnt (kills n>=4 → || and the >= boundary).
    const tooFew = await bins({
      n_scores: 3,
      seed_score: 0,
      last_score: 2,
      min_score: -4,
    });
    expect(tooFew.bins.improved).toContain('क');
    expect(tooFew.bins.learnt).not.toContain('क');
  });

  it('a shallow dip (min between seed-4 and seed) is improved, not learnt (kills seed-4 → seed+4)', async () => {
    // n>=4, last>seed, min=seed-2 (dip not deep enough). Correct: -2 <= -4 false → improved.
    // Mutant seed+4: -2 <= 4 true → would be learnt. Asserting improved kills it.
    const out = await bins({
      n_scores: 5,
      seed_score: 0,
      last_score: 3,
      min_score: -2,
    });
    expect(out.bins.improved).toContain('क');
    expect(out.bins.learnt).not.toContain('क');
  });

  it('coerces a string n_scores (pg COUNT text) before the numeric comparisons', async () => {
    const out = await bins({
      n_scores: '5',
      seed_score: 0,
      last_score: 2,
      min_score: -4,
    });
    expect(out.bins.learnt).toContain('क');
  });

  it('treats null n_scores as 0 → untouched (kills the n_scores===null ternary)', async () => {
    const out = await bins({
      n_scores: null,
      seed_score: null,
      last_score: null,
      min_score: null,
    });
    expect(out.bins.untouched).toContain('क');
  });
});

describe('ScoreService.createSeedScores — full seed contract', () => {
  it('inserts exactly the SEED_SCORES (grapheme, score) sequence after the user id', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { service } = makeService(query);
    await service.createSeedScores('u1');
    const params = query.mock.calls[0][1];
    const expected: unknown[] = ['u1'];
    for (const [g, s] of SEED_PAIRS) expected.push(g, s);
    expect(params).toEqual(expected); // kills every SEED_SCORES `{}` ObjectLiteral mutant
  });

  it('builds an INSERT...SELECT...UNION ALL over the letters table', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { service } = makeService(query);
    await service.createSeedScores('u1');
    const sql: string = query.mock.calls[0][0];
    expect(sql).toContain('INSERT INTO scores (user_id, letter_id, score)');
    expect(sql).toContain('SELECT $1::uuid, l.id,');
    expect(sql).toContain(
      '::double precision FROM letters l WHERE l.grapheme =',
    );
    expect(sql).toContain('UNION ALL');
  });
});
