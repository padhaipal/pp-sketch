// Golden-output test for the 2026-09 extraction of the literacy test-score
// algorithm out of UserService.getLiteracyTestScores. GOLDEN_JSON was
// captured by running the PRE-refactor UserService over goldenFixtureRows —
// JSON.stringify of getLiteracyTestScores per user — and must never be
// regenerated from the new code. If the algorithm is meant to change, the
// change is a product decision and this literal is updated deliberately.
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'gen-uuid'),
  validate: (s: unknown): boolean =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));

import { UserService } from '../../users/user.service';
import {
  computeLatestLiteracyTestScores,
  computeLiteracyTestScores,
  dedupeFirstAttempts,
  fetchFirstAttempts,
  metricPools,
  mplBSnapshot,
  nipunSnapshot,
  NIPUN_QUESTION_COUNT,
  snapshotLatest,
  snapshotSeries,
  type ComprehensionRow,
  type FirstAttempt,
} from './literacy-test-scores';

// Deterministic comprehension-answer fixtures (the comprehension query's row
// shape). Byte-for-byte the fixture the golden was captured with.
export const GOLDEN_USERS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
export interface GoldenRow {
  user_id: string;
  created_at: Date;
  answer_correct: boolean;
  question_id: string;
  question_type: string | null;
  level: number | null;
}
export function goldenFixtureRows(userId: string): GoldenRow[] {
  const day = (n: number) => new Date(Date.UTC(2026, 6, 1) + n * 86_400_000);
  const row = (
    n: number,
    correct: boolean,
    level: number | null,
    type: string | null,
    qid = `q${n}`,
  ): GoldenRow => ({
    user_id: userId,
    created_at: day(n),
    answer_correct: correct,
    question_id: qid,
    question_type: type,
    level,
  });
  if (userId === GOLDEN_USERS[0]) {
    const rows: GoldenRow[] = [];
    // NIPUN g2: six level-10 R1.x first attempts, one repeat (ignored), one R2 (ignored).
    rows.push(row(1, true, 10, 'R1.1'));
    rows.push(row(2, false, 10, 'R1.2'));
    rows.push(row(3, true, 10, 'R1.3'));
    rows.push(row(4, true, 10, 'R1.1'));
    rows.push(row(5, false, 10, 'R1.2', 'q2')); // repeat of q2 → dropped
    rows.push(row(6, true, 10, 'R2.1'));
    rows.push(row(7, false, 10, 'R1.3'));
    rows.push(row(8, true, 10, 'R1.1'));
    // NIPUN g3 + MPL-B: 22 level-11/12 first attempts across four types, one level-13.
    const types = [
      'R1.1',
      'R1.2',
      'R1.3',
      'R2.1',
      'R2.2',
      'R2.3',
      'R3.1',
      'R1.1',
      'R1.2',
      'R2.1',
      'R2.2',
      'R1.3',
      'R3.2',
      'R1.1',
      'R2.3',
      'R1.2',
      'R2.1',
      'R1.3',
      'R2.2',
      'R1.1',
      'R3.1',
      'R2.3',
    ];
    types.forEach((t, i) => {
      rows.push(row(10 + i, i % 3 !== 0, i % 2 === 0 ? 11 : 12, t));
    });
    rows.push(row(40, true, 13, 'R1.1'));
    rows.push(row(41, true, null, 'R1.1'));
    rows.push(row(42, true, 11, null));
    return rows;
  }
  if (userId === GOLDEN_USERS[1]) {
    return [
      row(1, true, 10, 'R1.1'),
      row(2, true, 11, 'R1.2'),
      row(3, false, 12, 'R2.1'),
    ];
  }
  return [];
}

const GOLDEN_JSON =
  '{"11111111-1111-4111-8111-111111111111":{"nipun_grade_2":{"status":"ok","attempts_available":6,"latest":{"at":"2026-07-09T00:00:00.000Z","score":0.75,"passed":true},"history":[{"at":"2026-07-05T00:00:00.000Z","score":0.75,"passed":true},{"at":"2026-07-08T00:00:00.000Z","score":0.5,"passed":false},{"at":"2026-07-09T00:00:00.000Z","score":0.75,"passed":true}]},"nipun_grade_3":{"status":"ok","attempts_available":10,"latest":{"at":"2026-07-30T00:00:00.000Z","score":0.75,"passed":true},"history":[{"at":"2026-07-18T00:00:00.000Z","score":0.75,"passed":true},{"at":"2026-07-19T00:00:00.000Z","score":1,"passed":true},{"at":"2026-07-22T00:00:00.000Z","score":1,"passed":true},{"at":"2026-07-24T00:00:00.000Z","score":1,"passed":true},{"at":"2026-07-26T00:00:00.000Z","score":0.75,"passed":true},{"at":"2026-07-28T00:00:00.000Z","score":0.75,"passed":true},{"at":"2026-07-30T00:00:00.000Z","score":0.75,"passed":true}]},"mpl_b":{"status":"ok","attempts_available":23,"latest":{"at":"2026-08-12T00:00:00.000Z","score":0.65,"passed":true},"history":[{"at":"2026-07-30T00:00:00.000Z","score":0.65,"passed":true},{"at":"2026-07-31T00:00:00.000Z","score":0.7,"passed":true},{"at":"2026-08-01T00:00:00.000Z","score":0.65,"passed":true},{"at":"2026-08-12T00:00:00.000Z","score":0.65,"passed":true}]}},"22222222-2222-4222-8222-222222222222":{"nipun_grade_2":{"status":"insufficient_data","attempts_available":1},"nipun_grade_3":{"status":"insufficient_data","attempts_available":1},"mpl_b":{"status":"insufficient_data","attempts_available":2}},"33333333-3333-4333-8333-333333333333":{"nipun_grade_2":{"status":"insufficient_data","attempts_available":0},"nipun_grade_3":{"status":"insufficient_data","attempts_available":0},"mpl_b":{"status":"insufficient_data","attempts_available":0}}}';

function queryFor(rowsByUser: (id: string) => ComprehensionRow[]) {
  return jest.fn(async (sql: string, params?: unknown[]) => {
    if (!sql.includes('comprehension-complete')) return [];
    const ids = (params?.[0] as string[]) ?? [];
    return ids.flatMap((id) => rowsByUser(id));
  });
}

describe('literacy test scores — golden output', () => {
  it('UserService.getLiteracyTestScores is byte-identical to the pre-refactor implementation', async () => {
    const out: Record<string, unknown> = {};
    for (const id of GOLDEN_USERS) {
      const query = queryFor(goldenFixtureRows);
      const svc = new UserService(
        {
          findOneBy: jest
            .fn()
            .mockResolvedValue({ id, external_id: '919999990001' }),
        } as never,
        { query } as never,
        {
          get: jest.fn().mockResolvedValue(null),
          set: jest.fn(),
          del: jest.fn(),
        } as never,
        { createSeedScores: jest.fn() } as never,
        { delete: jest.fn() } as never,
      );
      out[id] = await svc.getLiteracyTestScores(id);
    }
    expect(JSON.stringify(out)).toBe(GOLDEN_JSON);
  });

  it('computeLiteracyTestScores over all three users in one query matches the golden per user', async () => {
    const query = queryFor(goldenFixtureRows);
    const scores = await computeLiteracyTestScores(query, GOLDEN_USERS);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toMatch(
      /s\.user_id = ANY\(\$1::uuid\[\]\)/,
    );
    expect(query.mock.calls[0][1]).toEqual([GOLDEN_USERS]);
    const expected = JSON.parse(GOLDEN_JSON) as Record<string, unknown>;
    for (const id of GOLDEN_USERS) {
      expect(JSON.stringify(scores.get(id))).toBe(JSON.stringify(expected[id]));
    }
  });
});

describe('snapshotLatest', () => {
  const pools = (id: string) =>
    metricPools(dedupeFirstAttempts(goldenFixtureRows(id)));

  it('equals the last element of snapshotSeries for every pool, and is O(n) (one snapshot call)', () => {
    for (const id of GOLDEN_USERS) {
      const p = pools(id);
      const cases: Array<
        [FirstAttempt[], (x: FirstAttempt[]) => ReturnType<typeof mplBSnapshot>]
      > = [
        [p.nipun_g2, (x) => nipunSnapshot(x, NIPUN_QUESTION_COUNT)],
        [p.nipun_g3, (x) => nipunSnapshot(x, NIPUN_QUESTION_COUNT)],
        [p.mpl_b, mplBSnapshot],
      ];
      for (const [pool, fn] of cases) {
        const series = snapshotSeries(pool, fn);
        const spy = jest.fn(fn);
        const latest = snapshotLatest(pool, spy);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(latest.status).toBe(series.status);
        expect(latest.attempts_available).toBe(series.attempts_available);
        expect(latest.latest).toEqual(series.latest);
        expect(latest).not.toHaveProperty('history');
      }
    }
  });

  it('computeLatestLiteracyTestScores flattens to {score, passed, attempts} per metric', async () => {
    const query = queryFor(goldenFixtureRows);
    const latest = await computeLatestLiteracyTestScores(query, GOLDEN_USERS);
    const golden = JSON.parse(GOLDEN_JSON) as Record<
      string,
      Record<
        string,
        {
          attempts_available: number;
          latest?: { score: number; passed: boolean };
        }
      >
    >;
    for (const id of GOLDEN_USERS) {
      const g = golden[id];
      expect(latest.get(id)).toEqual({
        nipun_g2: {
          score: g.nipun_grade_2.latest?.score ?? null,
          passed: g.nipun_grade_2.latest?.passed ?? null,
          attempts: g.nipun_grade_2.attempts_available,
        },
        nipun_g3: {
          score: g.nipun_grade_3.latest?.score ?? null,
          passed: g.nipun_grade_3.latest?.passed ?? null,
          attempts: g.nipun_grade_3.attempts_available,
        },
        mpl_b: {
          score: g.mpl_b.latest?.score ?? null,
          passed: g.mpl_b.latest?.passed ?? null,
          attempts: g.mpl_b.attempts_available,
        },
      });
    }
  });
});

describe('fetchFirstAttempts', () => {
  it('returns an entry for every requested user, empty for users with no rows, and never queries for an empty list', async () => {
    const query = queryFor(goldenFixtureRows);
    const map = await fetchFirstAttempts(query, [
      GOLDEN_USERS[2],
      GOLDEN_USERS[1],
    ]);
    expect([...map.keys()]).toEqual([GOLDEN_USERS[2], GOLDEN_USERS[1]]);
    expect(map.get(GOLDEN_USERS[2])).toEqual([]);
    expect(map.get(GOLDEN_USERS[1])).toHaveLength(3);
    const none = jest.fn();
    expect(await fetchFirstAttempts(none, [])).toEqual(new Map());
    expect(none).not.toHaveBeenCalled();
  });

  it('attributes user_id-less rows to the single requested user (legacy fixtures) and drops them otherwise', async () => {
    const rows = goldenFixtureRows(GOLDEN_USERS[1]).map((r) => ({
      ...r,
      user_id: undefined,
    }));
    const query = jest.fn().mockResolvedValue(rows);
    expect(
      (await fetchFirstAttempts(query as never, [GOLDEN_USERS[1]])).get(
        GOLDEN_USERS[1],
      ),
    ).toHaveLength(3);
    const both = await fetchFirstAttempts(query as never, [
      GOLDEN_USERS[0],
      GOLDEN_USERS[1],
    ]);
    expect(both.get(GOLDEN_USERS[0])).toEqual([]);
    expect(both.get(GOLDEN_USERS[1])).toEqual([]);
  });
});
