// Golden-output test for the 2026-09 extraction of the literacy test-score
// algorithm out of UserService.getLiteracyTestScores. GOLDEN_JSON was
// captured by running the PRE-refactor UserService over goldenFixtureRows —
// JSON.stringify of getLiteracyTestScores per user — and must never be
// regenerated from the new code. If the algorithm is meant to change, the
// change is a product decision and this literal is updated deliberately.
// Updated 2026-10: NIPUN pass is ≥ 0.75 (three of four), and every test
// carries `counted_message_ids` and `bin_message_ids` (empty here — the fixture rows have no tap
// ids). Updated again 2026-10 for NIPUN grade 1: a `nipun_grade_1` block
// (insufficient, 0 attempts — the fixture has no level-8 lessons) was
// inserted first in every user's object; nothing else changed.
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'gen-uuid'),
  validate: (s: unknown): boolean =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));

import { UserService } from '../../users/user.service';
import {
  COMPREHENSION_ANSWERS_SQL,
  computeLatestLiteracyTestScores,
  computeLiteracyTestScores,
  dedupeFirstAttempts,
  fetchFirstAttempts,
  fetchLevel8Lessons,
  lessonsToAttempts,
  LEVEL8_LESSONS_SQL,
  metricPools,
  scoresFromAttempts,
  mplBSnapshot,
  nipunSnapshot,
  NIPUN_QUESTION_COUNT,
  snapshotLatest,
  snapshotSeries,
  type ComprehensionRow,
  type FirstAttempt,
  type Level8LessonRow,
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
  '{"11111111-1111-4111-8111-111111111111":{"nipun_grade_1":{"status":"insufficient_data","attempts_available":0,"counted_message_ids":[],"bin_message_ids":[]},"nipun_grade_2":{"status":"ok","attempts_available":6,"latest":{"at":"2026-07-09T00:00:00.000Z","score":0.75,"passed":true},"history":[{"at":"2026-07-05T00:00:00.000Z","score":0.75,"passed":true},{"at":"2026-07-08T00:00:00.000Z","score":0.5,"passed":false},{"at":"2026-07-09T00:00:00.000Z","score":0.75,"passed":true}],"counted_message_ids":[],"bin_message_ids":[]},"nipun_grade_3":{"status":"ok","attempts_available":10,"latest":{"at":"2026-07-30T00:00:00.000Z","score":0.75,"passed":true},"history":[{"at":"2026-07-18T00:00:00.000Z","score":0.75,"passed":true},{"at":"2026-07-19T00:00:00.000Z","score":1,"passed":true},{"at":"2026-07-22T00:00:00.000Z","score":1,"passed":true},{"at":"2026-07-24T00:00:00.000Z","score":1,"passed":true},{"at":"2026-07-26T00:00:00.000Z","score":0.75,"passed":true},{"at":"2026-07-28T00:00:00.000Z","score":0.75,"passed":true},{"at":"2026-07-30T00:00:00.000Z","score":0.75,"passed":true}],"counted_message_ids":[],"bin_message_ids":[]},"mpl_b":{"status":"ok","attempts_available":23,"latest":{"at":"2026-08-12T00:00:00.000Z","score":0.65,"passed":true},"history":[{"at":"2026-07-30T00:00:00.000Z","score":0.65,"passed":true},{"at":"2026-07-31T00:00:00.000Z","score":0.7,"passed":true},{"at":"2026-08-01T00:00:00.000Z","score":0.65,"passed":true},{"at":"2026-08-12T00:00:00.000Z","score":0.65,"passed":true}],"counted_message_ids":[],"bin_message_ids":[]}},"22222222-2222-4222-8222-222222222222":{"nipun_grade_1":{"status":"insufficient_data","attempts_available":0,"counted_message_ids":[],"bin_message_ids":[]},"nipun_grade_2":{"status":"insufficient_data","attempts_available":1,"counted_message_ids":[],"bin_message_ids":[]},"nipun_grade_3":{"status":"insufficient_data","attempts_available":1,"counted_message_ids":[],"bin_message_ids":[]},"mpl_b":{"status":"insufficient_data","attempts_available":2,"counted_message_ids":[],"bin_message_ids":[]}},"33333333-3333-4333-8333-333333333333":{"nipun_grade_1":{"status":"insufficient_data","attempts_available":0,"counted_message_ids":[],"bin_message_ids":[]},"nipun_grade_2":{"status":"insufficient_data","attempts_available":0,"counted_message_ids":[],"bin_message_ids":[]},"nipun_grade_3":{"status":"insufficient_data","attempts_available":0,"counted_message_ids":[],"bin_message_ids":[]},"mpl_b":{"status":"insufficient_data","attempts_available":0,"counted_message_ids":[],"bin_message_ids":[]}}}';

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

  it('computeLiteracyTestScores over all three users in two queries (answers, level-8 lessons) matches the golden per user', async () => {
    const query = queryFor(goldenFixtureRows);
    const scores = await computeLiteracyTestScores(query, GOLDEN_USERS);
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).toMatch(
      /s\.user_id = ANY\(\$1::uuid\[\]\)/,
    );
    expect(query.mock.calls[0][1]).toEqual([GOLDEN_USERS]);
    expect(query.mock.calls[1][0]).toBe(LEVEL8_LESSONS_SQL);
    expect(query.mock.calls[1][1]).toEqual([GOLDEN_USERS]);
    const expected = JSON.parse(GOLDEN_JSON) as Record<string, unknown>;
    for (const id of GOLDEN_USERS) {
      expect(JSON.stringify(scores.get(id))).toBe(JSON.stringify(expected[id]));
    }
  });
});

describe('counted_message_ids', () => {
  const att = (n: number, correct = true, type = 'R1.1'): FirstAttempt => ({
    at: new Date(Date.UTC(2026, 6, n)),
    correct,
    question_id: `q${n}`,
    message_id: `m${n}`,
    level: 10,
    question_type: type,
  });
  const nipun = (p: FirstAttempt[]) => nipunSnapshot(p, NIPUN_QUESTION_COUNT);

  it('NIPUN: the taps behind the latest snapshot (the last four attempts)', () => {
    const pool = [1, 2, 3, 4, 5, 6, 7].map((n) => att(n));
    const out = snapshotSeries(pool, nipun);
    expect(out.status).toBe('ok');
    // the current score's four only
    expect(out.counted_message_ids).toEqual(['m4', 'm5', 'm6', 'm7']);
    // the whole bin: every first attempt in the pool
    expect(out.bin_message_ids).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
      'm7',
    ]);
    // exactly four attempts: one history point, so just those four
    expect(snapshotSeries(pool.slice(0, 4), nipun).counted_message_ids).toEqual(
      ['m1', 'm2', 'm3', 'm4'],
    );
  });

  it('insufficient data: every attempt answered so far; none → []', () => {
    const out = snapshotSeries([att(1), att(2)], nipun);
    expect(out.status).toBe('insufficient_data');
    expect(out.counted_message_ids).toEqual(['m1', 'm2']);
    expect(snapshotSeries([], nipun).counted_message_ids).toEqual([]);
  });

  it('skips attempts without a tap id and never repeats one', () => {
    const pool = [att(1), att(2), { ...att(3), message_id: null }, att(4)];
    expect(snapshotSeries(pool, nipun).counted_message_ids).toEqual([
      'm1',
      'm2',
      'm4',
    ]);
  });

  it('3 of 4 right passes NIPUN (≥ 0.75); 2 of 4 does not', () => {
    expect(nipun([att(1), att(2), att(3), att(4, false)])?.passed).toBe(true);
    expect(nipun([att(1), att(2), att(3, false), att(4, false)])?.passed).toBe(
      false,
    );
  });

  it('the comprehension query carries the tap id through to the attempt', () => {
    const rows: ComprehensionRow[] = [
      {
        user_id: 'u',
        created_at: new Date(0),
        answer_correct: true,
        question_id: 'q1',
        message_id: 'tap-1',
        question_type: 'R1.1',
        level: 10,
      },
      {
        user_id: 'u',
        created_at: new Date(1),
        answer_correct: true,
        question_id: 'q1',
        message_id: 'tap-2',
        question_type: 'R1.1',
        level: 10,
      },
    ];
    expect(dedupeFirstAttempts(rows).map((a) => a.message_id)).toEqual([
      'tap-1',
    ]);
    expect(COMPREHENSION_ANSWERS_SQL).toMatch(
      /s\.user_message_id AS message_id/,
    );
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
        nipun_g1: {
          score: g.nipun_grade_1.latest?.score ?? null,
          passed: g.nipun_grade_1.latest?.passed ?? null,
          attempts: g.nipun_grade_1.attempts_available,
        },
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

describe('NIPUN grade 1 — level-8 lesson reads', () => {
  const lesson = (
    n: number,
    first_try: boolean,
    level: number | null = 8,
  ): Level8LessonRow => ({
    user_id: 'u1',
    created_at: new Date(Date.UTC(2026, 8, n)),
    lesson_id: `l${n}`,
    message_id: `m${n}`,
    first_try,
    level,
  });

  it('the query selects finished level-8 lessons that ended on the read, first_try from the done stid, without a rolled_back filter', () => {
    expect(LEVEL8_LESSONS_SQL).toContain("s.snapshot->>'status' = 'done'");
    expect(LEVEL8_LESSONS_SQL).toContain("LIKE '%-sentence-complete-%'");
    expect(LEVEL8_LESSONS_SQL).toContain(
      "LIKE '%-sentence-complete-correct-first') AS first_try",
    );
    expect(LEVEL8_LESSONS_SQL).toContain('s.passage_id IS NOT NULL');
    expect(LEVEL8_LESSONS_SQL).not.toContain('rolled_back');
    expect(LEVEL8_LESSONS_SQL).not.toContain('comprehension');
  });

  it('lessonsToAttempts: the lesson row is the question, the completing voice note the tap', () => {
    expect(lessonsToAttempts([lesson(1, true), lesson(2, false)])).toEqual([
      {
        at: new Date(Date.UTC(2026, 8, 1)),
        correct: true,
        question_id: 'l1',
        message_id: 'm1',
        level: 8,
        question_type: null,
      },
      {
        at: new Date(Date.UTC(2026, 8, 2)),
        correct: false,
        question_id: 'l2',
        message_id: 'm2',
        level: 8,
        question_type: null,
      },
    ]);
  });

  it('pools: lessons feed nipun_g1 only (level 8); comprehension attempts never do', () => {
    const lessons = lessonsToAttempts([
      lesson(1, true),
      lesson(2, true, 9),
      lesson(3, true, null),
    ]);
    const pools = metricPools([], lessons);
    expect(pools.nipun_g1.map((a) => a.question_id)).toEqual(['l1']);
    expect(pools.nipun_g2).toEqual([]);
    const attempt: FirstAttempt = {
      at: new Date(Date.UTC(2026, 8, 1)),
      correct: true,
      question_id: 'q',
      message_id: null,
      level: 8,
      question_type: 'R1.1',
    };
    expect(metricPools([attempt]).nipun_g1).toEqual([]);
  });

  it('scores the last four lessons: three first-try reads pass, two fail, three lessons are insufficient; history replays every prefix', () => {
    const four = lessonsToAttempts([
      lesson(1, false),
      lesson(2, true),
      lesson(3, true),
      lesson(4, true),
      lesson(5, false),
    ]);
    const out = scoresFromAttempts([], four).nipun_grade_1;
    expect(out.status).toBe('ok');
    expect(out.attempts_available).toBe(5);
    expect(out.history).toEqual([
      { at: new Date(Date.UTC(2026, 8, 4)), score: 0.75, passed: true },
      { at: new Date(Date.UTC(2026, 8, 5)), score: 0.75, passed: true },
    ]);
    expect(out.counted_message_ids).toEqual(['m2', 'm3', 'm4', 'm5']);
    expect(out.bin_message_ids).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);

    const two = scoresFromAttempts(
      [],
      lessonsToAttempts([
        lesson(1, true),
        lesson(2, true),
        lesson(3, false),
        lesson(4, false),
      ]),
    ).nipun_grade_1;
    expect(two.latest).toMatchObject({ score: 0.5, passed: false });

    const three = scoresFromAttempts(
      [],
      lessonsToAttempts([lesson(1, true), lesson(2, true), lesson(3, true)]),
    ).nipun_grade_1;
    expect(three.status).toBe('insufficient_data');
    expect(three.attempts_available).toBe(3);
    // Without lessons the key is still there, empty.
    expect(scoresFromAttempts([]).nipun_grade_1).toMatchObject({
      status: 'insufficient_data',
      attempts_available: 0,
    });
  });

  it('fetchLevel8Lessons: one query over every id, an entry per id, rows grouped by user', async () => {
    const rows: Level8LessonRow[] = [
      lesson(1, true),
      { ...lesson(2, false), user_id: 'u2' },
    ];
    const query = jest.fn(async () => rows);
    const out = await fetchLevel8Lessons(query, ['u1', 'u2', 'u3']);
    expect(query).toHaveBeenCalledWith(LEVEL8_LESSONS_SQL, [
      ['u1', 'u2', 'u3'],
    ]);
    expect(out.get('u1')?.map((a) => a.question_id)).toEqual(['l1']);
    expect(out.get('u2')?.map((a) => a.question_id)).toEqual(['l2']);
    expect(out.get('u3')).toEqual([]);
    expect((await fetchLevel8Lessons(query, [])).size).toBe(0);
  });

  it('the nightly latest point carries nipun_g1 too', async () => {
    const query = jest.fn(async (sql: string) =>
      sql === LEVEL8_LESSONS_SQL
        ? [lesson(1, true), lesson(2, true), lesson(3, true), lesson(4, false)]
        : [],
    );
    const latest = await computeLatestLiteracyTestScores(query, ['u1']);
    expect(latest.get('u1')?.nipun_g1).toEqual({
      score: 0.75,
      passed: true,
      attempts: 4,
    });
    expect(latest.get('u1')?.nipun_g2).toEqual({
      score: null,
      passed: null,
      attempts: 0,
    });
  });
});
