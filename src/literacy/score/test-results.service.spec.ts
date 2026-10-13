jest.mock('../../interfaces/redis/queues', () => ({
  QUEUE_NAMES: { TEST_RESULTS: 'test-results' },
  createQueue: jest.fn(),
}));

import type { DataSource } from 'typeorm';
import { createQueue } from '../../interfaces/redis/queues';
import {
  addVector,
  bandVerdict,
  cohortVector,
  emptyVector,
  HIST_LENGTH,
  impliedNipunG2,
  METRICS,
  NIPUN_SCHOOL_MIN_COHORT,
  NIPUN_SCHOOL_MIN_PASSERS,
  schoolVerdict,
  STALE_RUN_HOURS,
  STUDENT_BATCH_SIZE,
  studentVector,
  TestResultsService,
  TestRunInProgressError,
  VERDICT_COLUMNS,
  verdictVector,
  type GeoVector,
  type LatestStudentRow,
} from './test-results.service';
import type { GeoEntityService } from '../../geo-entities/geo-entity.service';
import type { ComprehensionRow } from './literacy-test-scores';

// ─── In-memory database driven by the SQL tags the service emits ─────────────

interface Student {
  id: string;
  birth_year: number | null;
  birth_month: number | null;
  referrer_geo: string | null; // referrer.geo_entity_id (null: no staff referrer)
  role?: string;
  deleted?: boolean;
  created_at?: Date; // onboarding day (age-bands.ts estimates a missing month from it)
}
interface ResultRow {
  student_id: string;
  geo_entity_id: string | null;
  computed_for: string;
  scores: unknown[]; // the 9 metric params in order
  created_at: Date;
}
interface GeoRow {
  geo_entity_id: string;
  computed_for: string;
  students_active: number;
  students_scored: number;
  students_unbanded: number;
  nipun_g2_cohort: number;
  nipun_g3_cohort: number;
  nipun_school_passed: boolean | null;
  nipun_schools_pass: number;
  nipun_schools_fail: number;
  nipun_schools_insufficient: number;
  metrics: Record<
    string,
    { n: number; sum: string; sumsq: string; pass: number; hist: number[] }
  >;
}
interface Run {
  id: string;
  started_at: Date;
  full: boolean;
  status: string;
  error?: string;
  students_candidates?: number;
  students_scored?: number;
  geo_rows?: number;
}

// Tree: district D → blocks B1, B2; B1 → schools S1, S2; B2 → S3.
// A referrer may sit on a block directly (B2 as a leaf).
const ANCESTORS: Record<string, string[]> = {
  S1: ['D', 'B1'],
  S2: ['D', 'B1'],
  S3: ['D', 'B2'],
  B2: ['D'],
};
const GEO_TYPE = (id: string) =>
  id.startsWith('S') ? 'school' : id.startsWith('B') ? 'block' : 'district';

class FakeDb {
  students: Student[] = [];
  lessons = new Map<string, Date[]>();
  voiceNotes = new Map<string, Date[]>();
  // Comprehension flow taps (activity events alongside the voice notes).
  taps = new Map<string, Date[]>();
  answers = new Map<string, ComprehensionRow[]>();
  results: ResultRow[] = [];
  geo: GeoRow[] = [];
  runs: Run[] = [];
  clock = new Date('2026-09-12T00:00:00Z');
  failOn: string | null = null;
  private runSeq = 0;

  tick(): Date {
    this.clock = new Date(this.clock.getTime() + 1000);
    return this.clock;
  }

  query = jest.fn(
    async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
      const tag =
        /\/\* ([a-z-]+:[a-z-]+) \*\//.exec(sql)?.[1] ?? sql.trim().slice(0, 40);
      if (this.failOn && tag === this.failOn)
        throw new Error(`injected failure at ${tag}`);
      switch (tag) {
        case 'test-results:running': {
          const hours = Number(params[0]);
          const cutoff = Date.now() - hours * 3_600_000;
          return this.runs
            .filter(
              (r) => r.status === 'running' && r.started_at.getTime() > cutoff,
            )
            .map((r) => ({ id: r.id }));
        }
        case 'test-results:start': {
          const run: Run = {
            id: `run-${++this.runSeq}`,
            started_at: params[0] as Date,
            full: params[1] as boolean,
            status: 'running',
          };
          this.runs.push(run);
          return [{ id: run.id }];
        }
        case 'test-results:candidates': {
          const full = params[0] as boolean;
          return this.students
            .filter((s) => (s.role ?? 'student') === 'student' && !s.deleted)
            .filter((s) => {
              if (full) return true;
              const latest = Math.max(
                -Infinity,
                ...this.results
                  .filter((r) => r.student_id === s.id)
                  .map((r) => r.created_at.getTime()),
              );
              return [
                ...(this.lessons.get(s.id) ?? []),
                ...(this.voiceNotes.get(s.id) ?? []),
              ].some((l) => l.getTime() > latest);
            })
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((s) => ({
              id: s.id,
              birth_year: s.birth_year,
              birth_month: s.birth_month,
              geo_entity_id: s.referrer_geo,
            }));
        }
        case 'literacy-test-scores:comprehension-answers': {
          const ids = params[0] as string[];
          return ids.flatMap((id) => this.answers.get(id) ?? []);
        }
        case 'test-results:voice-notes': {
          const ids = params[0] as string[];
          const start = (params[1] as Date).getTime();
          const end = (params[2] as Date).getTime();
          // Live voice notes + flow taps, one shared predicate (active-time.ts).
          expect(sql).toContain(
            "source = 'whatsapp' AND (media_type = 'audio' OR (media_type = 'text' AND media_details->>'nfm_reply' = 'true')) AND rolled_back = false",
          );
          expect(sql).toContain("(media_type = 'text') AS tap");
          return ids.flatMap((id) =>
            [
              ...(this.voiceNotes.get(id) ?? []).map((t) => ({
                t,
                tap: false,
              })),
              ...(this.taps.get(id) ?? []).map((t) => ({ t, tap: true })),
            ]
              .filter(({ t }) => t.getTime() >= start && t.getTime() < end)
              .sort((a, b) => a.t.getTime() - b.t.getTime())
              .map(({ t, tap }) => ({ user_id: id, created_at: t, tap })),
          );
        }
        case 'test-results:upsert-students': {
          const created = this.tick();
          for (let i = 0; i < params.length; i += 15) {
            const [student_id, geo_entity_id, computed_for, ...scores] =
              params.slice(i, i + 15) as [
                string,
                string | null,
                string,
                ...unknown[],
              ];
            this.results = this.results.filter(
              (r) =>
                !(
                  r.student_id === student_id && r.computed_for === computed_for
                ),
            );
            this.results.push({
              student_id,
              geo_entity_id,
              computed_for,
              scores,
              created_at: created,
            });
          }
          return [];
        }
        case 'test-results:latest-students': {
          const since = (params[0] as Date).getTime();
          const computedFor = params[1] as string;
          const latest = new Map<string, ResultRow>();
          for (const r of [...this.results].sort(
            (a, b) => b.created_at.getTime() - a.created_at.getTime(),
          )) {
            if (!latest.has(r.student_id)) latest.set(r.student_id, r);
          }
          return [...latest.values()].flatMap((r) => {
            const s = this.students.find((x) => x.id === r.student_id);
            if (!s || (s.role ?? 'student') !== 'student' || s.deleted)
              return [];
            const [g2s, g2p, , g3s, g3p, , mbs, mbp] = r.scores as [
              number | null,
              boolean | null,
              number,
              number | null,
              boolean | null,
              number,
              number | null,
              boolean | null,
            ];
            return [
              {
                student_id: s.id,
                geo_entity_id: s.referrer_geo,
                birth_year: s.birth_year,
                birth_month: s.birth_month,
                created_at: s.created_at ?? null,
                nipun_g2_score: g2s,
                nipun_g2_passed: g2p,
                nipun_g3_score: g3s,
                nipun_g3_passed: g3p,
                mpl_b_score: mbs,
                mpl_b_passed: mbp,
                usage_score:
                  r.computed_for === computedFor
                    ? (r.scores[9] as number | null)
                    : null,
                active: (this.lessons.get(s.id) ?? []).some(
                  (l) => l.getTime() >= since,
                ),
              },
            ];
          });
        }
        case 'test-results:cohort': {
          return this.students
            .filter(
              (s) =>
                (s.role ?? 'student') === 'student' &&
                !s.deleted &&
                s.birth_year !== null &&
                s.referrer_geo !== null,
            )
            .map((s) => ({
              geo_entity_id: s.referrer_geo,
              birth_year: s.birth_year,
              birth_month: s.birth_month,
              created_at: s.created_at ?? null,
            }));
        }
        case 'test-results:leaf-types': {
          return (params[0] as string[]).map((id) => ({
            id,
            type: GEO_TYPE(id),
          }));
        }
        case 'test-results:upsert-geo': {
          const head = 5 + VERDICT_COLUMNS.length;
          const per = head + METRICS.length * 5;
          for (let i = 0; i < params.length; i += per) {
            const p = params.slice(i, i + per);
            const row: GeoRow = {
              geo_entity_id: p[0] as string,
              computed_for: p[1] as string,
              students_active: p[2] as number,
              students_scored: p[3] as number,
              students_unbanded: p[4] as number,
              nipun_g2_cohort: p[5] as number,
              nipun_g3_cohort: p[6] as number,
              nipun_school_passed: p[7] as boolean | null,
              nipun_schools_pass: p[8] as number,
              nipun_schools_fail: p[9] as number,
              nipun_schools_insufficient: p[10] as number,
              metrics: {},
            };
            METRICS.forEach((m, k) => {
              const b = head + k * 5;
              row.metrics[m] = {
                n: p[b] as number,
                sum: p[b + 1] as string,
                sumsq: p[b + 2] as string,
                pass: p[b + 3] as number,
                hist: p[b + 4] as number[],
              };
            });
            this.geo = this.geo.filter(
              (g) =>
                !(
                  g.geo_entity_id === row.geo_entity_id &&
                  g.computed_for === row.computed_for
                ),
            );
            this.geo.push(row);
          }
          return [];
        }
        case 'test-results:finish': {
          const run = this.runs.find((r) => r.id === params[0])!;
          Object.assign(run, {
            status: 'ok',
            students_candidates: params[1],
            students_scored: params[2],
            geo_rows: params[3],
          });
          return [];
        }
        case 'test-results:fail': {
          const run = this.runs.find((r) => r.id === params[0])!;
          Object.assign(run, { status: 'failed', error: params[1] });
          return [];
        }
        default:
          if (
            /SELECT id FROM test_runs WHERE status = 'running' ORDER BY/.test(
              sql,
            )
          ) {
            return this.runs
              .filter((r) => r.status === 'running')
              .slice(-1)
              .map((r) => ({ id: r.id }));
          }
          throw new Error(`unexpected SQL: ${tag}`);
      }
    },
  );
}

// Four level-10 R1.x first attempts with `correct` right answers → NIPUN g2
// score correct/4; also gives nipun_g3 nothing and mpl_b nothing.
function g2Answers(userId: string, correct: number): ComprehensionRow[] {
  return [0, 1, 2, 3].map((i) => ({
    user_id: userId,
    created_at: new Date(Date.UTC(2026, 8, 1 + i)),
    answer_correct: i < correct,
    question_id: `${userId}-q${i}`,
    question_type: 'R1.1',
    level: 10,
  }));
}

function makeService(db: FakeDb) {
  // ancestors() returns root first; map ids preserving that order.
  const geo = {
    ancestors: jest.fn(async (id: string) =>
      (ANCESTORS[id] ?? []).map((a) => ({ id: a })),
    ),
  };
  const svc = new TestResultsService(
    { query: db.query } as unknown as DataSource,
    geo as unknown as GeoEntityService,
  );
  return { svc, geo };
}

const NOW = new Date('2026-09-12T18:45:00Z'); // 00:15 IST on 2026-09-13
const COMPUTED_FOR = '2026-09-13';
const COMPUTED_FOR_DATE = new Date(`${COMPUTED_FOR}T00:00:00Z`);

function seed(db: FakeDb) {
  // birth 2019-07 → age 7 on 2026-09-13: in g2 [7,8) only.
  db.students = [
    { id: 'A', birth_year: 2019, birth_month: 7, referrer_geo: 'S1' }, // g2 0.75 — a pass at the ≥ 0.75 NIPUN mark
    { id: 'B', birth_year: 2019, birth_month: 7, referrer_geo: 'S1' }, // g2 0.25 fail
    { id: 'C', birth_year: 2019, birth_month: 7, referrer_geo: 'S2' }, // insufficient → scored=0
    { id: 'E', birth_year: 2010, birth_month: 1, referrer_geo: 'S2' }, // age 16: out of every band
    { id: 'F', birth_year: null, birth_month: null, referrer_geo: 'S3' }, // unbanded
    { id: 'G', birth_year: 2019, birth_month: 7, referrer_geo: 'S3' }, // g2 1.0 pass
    { id: 'H', birth_year: 2019, birth_month: 7, referrer_geo: null }, // no staff referrer → no geo
    {
      id: 'T',
      birth_year: null,
      birth_month: null,
      referrer_geo: 'S1',
      role: 'education_official',
    },
    {
      id: 'X',
      birth_year: 2019,
      birth_month: 7,
      referrer_geo: 'S1',
      deleted: true,
    },
  ];
  const recent = new Date('2026-09-10T00:00:00Z');
  const old = new Date('2026-08-01T00:00:00Z');
  db.lessons = new Map([
    ['A', [recent]],
    ['B', [recent]],
    ['C', [recent]],
    ['E', [old]],
    ['F', [recent]],
    ['G', [recent]],
    ['H', [recent]],
    ['X', [recent]],
  ]);
  db.answers = new Map([
    ['A', g2Answers('A', 3)],
    ['B', g2Answers('B', 1)],
    ['C', g2Answers('C', 2).slice(0, 2)],
    ['E', g2Answers('E', 4)],
    ['F', g2Answers('F', 2)],
    ['G', g2Answers('G', 4)],
    ['H', g2Answers('H', 4)],
  ]);
}

describe('TestResultsService.run — candidates and skip criterion', () => {
  it('first run scores every active student and records the run', async () => {
    const db = new FakeDb();
    seed(db);
    const { svc } = makeService(db);
    const summary = await svc.run({ full: false, now: NOW });
    expect(summary).toEqual({
      runId: 'run-1',
      computedFor: COMPUTED_FOR,
      full: false,
      candidates: 7,
      scored: 7,
      geoRows: 6,
    });
    expect(db.runs[0]).toEqual(
      expect.objectContaining({
        status: 'ok',
        students_candidates: 7,
        students_scored: 7,
        geo_rows: 6,
        full: false,
      }),
    );
    // Never the official or the deleted student.
    expect(db.results.map((r) => r.student_id).sort()).toEqual([
      'A',
      'B',
      'C',
      'E',
      'F',
      'G',
      'H',
    ]);
    const a = db.results.find((r) => r.student_id === 'A')!;
    expect(a.geo_entity_id).toBe('S1');
    expect(a.computed_for).toBe(COMPUTED_FOR);
    expect(a.scores).toEqual([
      0.75,
      true,
      4,
      null,
      null,
      0,
      null,
      null,
      0,
      null,
      null,
      0,
    ]);
  });

  it("a student with no new activity is not re-scored; geo rows are still rebuilt from everyone's latest row", async () => {
    const db = new FakeDb();
    seed(db);
    const { svc } = makeService(db);
    await svc.run({ full: false, now: NOW });
    const second = await svc.run({
      full: false,
      now: new Date(NOW.getTime() + 86_400_000),
    });
    expect(second.candidates).toBe(0);
    expect(second.scored).toBe(0);
    expect(second.geoRows).toBe(6);
    expect(db.geo.filter((g) => g.computed_for === '2026-09-14')).toHaveLength(
      6,
    );
  });

  it('a student missed by a failed night is picked up the next night', async () => {
    const db = new FakeDb();
    seed(db);
    const { svc } = makeService(db);
    await svc.run({ full: false, now: NOW });
    // New activity for A after run 1.
    db.lessons.get('A')!.push(new Date(NOW.getTime() + 3_600_000));

    db.failOn = 'test-results:upsert-students';
    await expect(
      svc.run({ full: false, now: new Date(NOW.getTime() + 86_400_000) }),
    ).rejects.toThrow(/injected failure/);
    expect(db.runs[1]).toEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.stringMatching(/injected failure/),
      }),
    );
    db.failOn = null;

    const third = await svc.run({
      full: false,
      now: new Date(NOW.getTime() + 2 * 86_400_000),
    });
    expect(third.candidates).toBe(1);
    expect(third.scored).toBe(1);
  });

  it('full: true re-scores everyone', async () => {
    const db = new FakeDb();
    seed(db);
    const { svc } = makeService(db);
    await svc.run({ full: false, now: NOW });
    const full = await svc.run({
      full: true,
      now: new Date(NOW.getTime() + 86_400_000),
    });
    expect(full.candidates).toBe(7);
    expect(full.scored).toBe(7);
    expect(db.runs[1].full).toBe(true);
  });

  it('scores in batches of STUDENT_BATCH_SIZE', async () => {
    const db = new FakeDb();
    seed(db);
    db.students = Array.from({ length: STUDENT_BATCH_SIZE + 1 }, (_, i) => ({
      id: `s${String(i).padStart(4, '0')}`,
      birth_year: 2019,
      birth_month: 7,
      referrer_geo: 'S1',
    }));
    db.lessons = new Map(
      db.students.map((s) => [s.id, [new Date('2026-09-10T00:00:00Z')]]),
    );
    db.answers = new Map();
    const { svc } = makeService(db);
    const summary = await svc.run({ full: false, now: NOW });
    expect(summary.scored).toBe(STUDENT_BATCH_SIZE + 1);
    const upserts = db.query.mock.calls.filter(([sql]) =>
      String(sql).includes('test-results:upsert-students'),
    );
    expect(
      upserts.map(([, params]) => (params as unknown[]).length / 15),
    ).toEqual([STUDENT_BATCH_SIZE, 1]);
  });
});

describe('TestResultsService.run — geo aggregation and roll-up', () => {
  // Direct computation over the fixture: each level's vector is the sum of
  // the studentVector of every student under it.
  function direct(db: FakeDb, ids: string[]): GeoVector {
    const v = emptyVector();
    for (const id of ids) {
      const s = db.students.find((x) => x.id === id)!;
      const r = db.results.find((x) => x.student_id === id)!;
      const [g2s, g2p, , g3s, g3p, , mbs, mbp] = r.scores as [
        number | null,
        boolean | null,
        number,
        number | null,
        boolean | null,
        number,
        number | null,
        boolean | null,
      ];
      const row: LatestStudentRow = {
        student_id: id,
        geo_entity_id: s.referrer_geo,
        birth_year: s.birth_year,
        birth_month: s.birth_month,
        created_at: s.created_at ?? null,
        active: (db.lessons.get(id) ?? []).some(
          (l) => l.getTime() >= COMPUTED_FOR_DATE.getTime() - 14 * 86_400_000,
        ),
        nipun_g2_score: g2s,
        nipun_g2_passed: g2p,
        nipun_g3_score: g3s,
        nipun_g3_passed: g3p,
        mpl_b_score: mbs,
        mpl_b_passed: mbp,
        usage_score:
          r.computed_for === COMPUTED_FOR
            ? (r.scores[9] as number | null)
            : null,
      };
      addVector(v, studentVector(row, COMPUTED_FOR_DATE));
      addVector(
        v,
        cohortVector(
          {
            geo_entity_id: s.referrer_geo!,
            birth_year: s.birth_year,
            birth_month: s.birth_month,
            created_at: s.created_at ?? null,
          },
          COMPUTED_FOR_DATE,
        ),
      );
    }
    return v;
  }
  // A school's verdict from its direct vector; an ancestor's counts are the
  // one-hot sum of the schools named.
  function withVerdicts(v: GeoVector, schools: GeoVector[]): GeoVector {
    for (const s of schools) addVector(v, verdictVector(schoolVerdict(s)));
    return v;
  }
  function stored(db: FakeDb, geoId: string): GeoVector {
    const g = db.geo.find(
      (x) => x.geo_entity_id === geoId && x.computed_for === COMPUTED_FOR,
    )!;
    const v = emptyVector();
    v.students_active = g.students_active;
    v.students_scored = g.students_scored;
    v.students_unbanded = g.students_unbanded;
    v.nipun_g2_cohort = g.nipun_g2_cohort;
    v.nipun_g3_cohort = g.nipun_g3_cohort;
    v.nipun_school_passed = g.nipun_school_passed;
    v.nipun_schools_pass = g.nipun_schools_pass;
    v.nipun_schools_fail = g.nipun_schools_fail;
    v.nipun_schools_insufficient = g.nipun_schools_insufficient;
    for (const m of METRICS) {
      v[m] = {
        n: g.metrics[m].n,
        sum: Number(g.metrics[m].sum),
        sumsq: Number(g.metrics[m].sumsq),
        pass: g.metrics[m].pass,
        hist: g.metrics[m].hist,
      };
    }
    return v;
  }
  const round = (v: GeoVector): GeoVector => {
    for (const m of METRICS) {
      v[m].sum = Number(v[m].sum.toFixed(3));
      v[m].sumsq = Number(v[m].sumsq.toFixed(4));
    }
    return v;
  };

  it('writes one row per school and per ancestor, and the roll-up equals direct computation', async () => {
    const db = new FakeDb();
    seed(db);
    const { svc, geo } = makeService(db);
    await svc.run({ full: false, now: NOW });

    expect(db.geo.map((g) => g.geo_entity_id).sort()).toEqual([
      'B1',
      'B2',
      'D',
      'S1',
      'S2',
      'S3',
    ]);
    // Ancestors are read once per school, never per student.
    expect(geo.ancestors).toHaveBeenCalledTimes(3);

    const s1 = direct(db, ['A', 'B']);
    const s2 = direct(db, ['C', 'E']);
    const s3 = direct(db, ['F', 'G']);
    const school = (v: GeoVector) => {
      const own = withVerdicts({ ...v }, [v]);
      own.nipun_school_passed = schoolVerdict(v);
      return own;
    };
    expect(stored(db, 'S1')).toEqual(round(school(s1)));
    expect(stored(db, 'S2')).toEqual(round(school(s2)));
    expect(stored(db, 'S3')).toEqual(round(school(s3)));
    expect(stored(db, 'B1')).toEqual(
      round(withVerdicts(direct(db, ['A', 'B', 'C', 'E']), [s1, s2])),
    );
    expect(stored(db, 'B2')).toEqual(
      round(withVerdicts(direct(db, ['F', 'G']), [s3])),
    );
    expect(stored(db, 'D')).toEqual(
      round(
        withVerdicts(direct(db, ['A', 'B', 'C', 'E', 'F', 'G']), [s1, s2, s3]),
      ),
    );
    // …and a block is exactly the sum of its schools (the verdict itself is
    // a school-only field, never summed).
    const b1 = addVector(stored(db, 'S1'), stored(db, 'S2'));
    b1.nipun_school_passed = null;
    expect(stored(db, 'B1')).toEqual(b1);
  });

  it('the fixture exercises every rule: pass/fail hist bins, insufficient, out-of-band, unbanded, inactive, no-geo', async () => {
    const db = new FakeDb();
    seed(db);
    const { svc } = makeService(db);
    await svc.run({ full: false, now: NOW });
    const s1 = stored(db, 'S1');
    expect(s1.students_active).toBe(2);
    expect(s1.students_scored).toBe(2);
    expect(s1.students_unbanded).toBe(0);
    expect(s1.nipun_g2).toEqual({
      n: 2,
      sum: 1,
      sumsq: 0.625,
      pass: 1, // 0.75 clears the ≥ 0.75 NIPUN mark, 0.25 does not
      hist: [0, 1, 0, 1, 0],
    });
    expect(s1.nipun_g3).toEqual({
      n: 0,
      sum: 0,
      sumsq: 0,
      pass: 0,
      hist: [0, 0, 0, 0, 0],
    });
    expect(s1.mpl_b.hist).toHaveLength(HIST_LENGTH.mpl_b);

    const s2 = stored(db, 'S2'); // C insufficient, E scored but out of band and inactive
    expect(s2.students_active).toBe(1);
    expect(s2.students_scored).toBe(1);
    expect(s2.nipun_g2.n).toBe(0);

    const s3 = stored(db, 'S3'); // F unbanded (scored 0.5), G 1.0
    expect(s3.students_unbanded).toBe(1);
    expect(s3.students_scored).toBe(2);
    expect(s3.nipun_g2).toEqual({
      n: 1,
      sum: 1,
      sumsq: 1,
      pass: 1,
      hist: [0, 0, 0, 0, 1],
    });

    // H has a score but no staff referrer → in no geo row.
    const d = stored(db, 'D');
    expect(d.students_scored).toBe(5);
  });
});

describe('NIPUN school verdict — pure rules', () => {
  const MIN = NIPUN_SCHOOL_MIN_PASSERS;
  const COHORT = NIPUN_SCHOOL_MIN_COHORT;

  it('bandVerdict: ≥ 9 passers AND ≥ 75 % (inclusive) passes; otherwise fail from 12 students, else null', () => {
    expect(bandVerdict(12, 9)).toBe(true); // exactly 75 %
    expect(bandVerdict(9, 9)).toBe(true); // a pass needs no minimum cohort
    expect(bandVerdict(10, 9)).toBe(true);
    expect(bandVerdict(20, 15)).toBe(true);
    expect(bandVerdict(12, 8)).toBe(false); // 8 < 9 passers
    expect(bandVerdict(13, 9)).toBe(false); // 9/13 < 75 %
    expect(bandVerdict(20, 14)).toBe(false);
    expect(bandVerdict(COHORT, 0)).toBe(false);
    expect(bandVerdict(COHORT - 1, 8)).toBeNull(); // 11 students, not passing
    expect(bandVerdict(0, 0)).toBeNull();
    expect(bandVerdict(MIN - 1, MIN - 1)).toBeNull(); // 8/8: too few passers
  });

  function school(
    g2: [cohort: number, pass: number],
    g3: [cohort: number, pass: number],
  ): GeoVector {
    const v = emptyVector();
    v.nipun_g2_cohort = g2[0];
    v.nipun_g2.pass = g2[1];
    v.nipun_g3_cohort = g3[0];
    v.nipun_g3.pass = g3[1];
    return v;
  }

  it('schoolVerdict: both bands pass → true; either band undecidable → null; otherwise false', () => {
    expect(schoolVerdict(school([12, 9], [12, 9]))).toBe(true);
    expect(schoolVerdict(school([9, 9], [10, 9]))).toBe(true); // small cohorts can pass
    expect(schoolVerdict(school([12, 9], [12, 8]))).toBe(false); // g2 passes, g3 fails
    expect(schoolVerdict(school([12, 8], [12, 8]))).toBe(false);
    expect(schoolVerdict(school([12, 9], [11, 8]))).toBeNull(); // g3 undecidable
    expect(schoolVerdict(school([12, 8], [6, 0]))).toBeNull(); // g2 fails but g3 undecidable
    expect(schoolVerdict(school([5, 0], [5, 0]))).toBeNull();
    expect(schoolVerdict(school([0, 0], [0, 0]))).toBeNull();
  });

  it('verdictVector is one-hot over pass / fail / insufficient', () => {
    expect(verdictVector(true)).toMatchObject({
      nipun_schools_pass: 1,
      nipun_schools_fail: 0,
      nipun_schools_insufficient: 0,
    });
    expect(verdictVector(false)).toMatchObject({
      nipun_schools_pass: 0,
      nipun_schools_fail: 1,
      nipun_schools_insufficient: 0,
    });
    expect(verdictVector(null)).toMatchObject({
      nipun_schools_pass: 0,
      nipun_schools_fail: 0,
      nipun_schools_insufficient: 1,
    });
  });

  it('cohortVector counts a student in the one band whose age range holds them, scored or not', () => {
    const on = new Date('2026-09-13T00:00:00Z');
    const student = (
      birth_year: number | null,
      birth_month: number | null,
      created_at: Date | null = null,
    ) => ({ geo_entity_id: 'S1', birth_year, birth_month, created_at });
    // age 7: g2 only
    expect(cohortVector(student(2019, 7), on)).toMatchObject({
      nipun_g2_cohort: 1,
      nipun_g3_cohort: 0,
    });
    // age 8: g3 only
    expect(cohortVector(student(2018, 7), on)).toMatchObject({
      nipun_g2_cohort: 0,
      nipun_g3_cohort: 1,
    });
    // age 9: no NIPUN test; age 10 is MPL-B only
    expect(cohortVector(student(2017, 7), on)).toMatchObject({
      nipun_g2_cohort: 0,
      nipun_g3_cohort: 0,
    });
    expect(cohortVector(student(2016, 7), on)).toMatchObject({
      nipun_g2_cohort: 0,
      nipun_g3_cohort: 0,
    });
    // unbanded: nothing
    expect(cohortVector(student(null, null), on)).toMatchObject({
      nipun_g2_cohort: 0,
      nipun_g3_cohort: 0,
    });
    // No birth month: estimated from onboarding. Said "7" in March 2026
    // (birth_year 2019) → born September 2018 → 8 on 2026-09-13 → g3.
    expect(
      cohortVector(student(2019, null, new Date('2026-03-15T03:30:00Z')), on),
    ).toMatchObject({ nipun_g2_cohort: 0, nipun_g3_cohort: 1 });
    // Said "7" in August 2026 → born February 2019 → still 7 → g2.
    expect(
      cohortVector(student(2019, null, new Date('2026-08-15T03:30:00Z')), on),
    ).toMatchObject({ nipun_g2_cohort: 1, nipun_g3_cohort: 0 });
  });
});

describe('TestResultsService.run — NIPUN school verdict roll-up', () => {
  const geoRow = (db: FakeDb, id: string) =>
    db.geo.find(
      (g) => g.geo_entity_id === id && g.computed_for === COMPUTED_FOR,
    )!;

  // `seven` students aged 7 (g2 band) and `eight` aged 8 (g3 band) in `geo`;
  // the first `g2Pass` seven-year-olds score 4/4 on g2. Nobody has g3
  // answers, so g3 is 0 of `eight` → g3 fails whenever decidable.
  function seedSchool(
    db: FakeDb,
    geo: string,
    seven: number,
    eight: number,
    g2Pass: number,
    prefix = 'P',
  ) {
    const recent = new Date('2026-09-10T00:00:00Z');
    for (let i = 0; i < seven + eight; i++) {
      const id = `${prefix}${i}`;
      db.students.push({
        id,
        birth_year: i < seven ? 2019 : 2018,
        birth_month: 7,
        referrer_geo: geo,
      });
      if (i < g2Pass) {
        db.lessons.set(id, [recent]);
        db.answers.set(id, g2Answers(id, 4));
      }
    }
  }

  it('the cohort counts every in-band student, scored or not; 12 + 12 with no passers fails', async () => {
    const db = new FakeDb();
    seedSchool(db, 'S1', 12, 12, 0); // nobody ever scored → no results rows at all
    const { svc } = makeService(db);
    await svc.run({ full: false, now: NOW });
    const s1 = geoRow(db, 'S1');
    expect(s1.students_scored).toBe(0);
    expect(s1.metrics.nipun_g2.n).toBe(0);
    expect(s1).toMatchObject({
      nipun_g2_cohort: 12,
      nipun_g3_cohort: 12,
      nipun_school_passed: false,
      nipun_schools_pass: 0,
      nipun_schools_fail: 1,
      nipun_schools_insufficient: 0,
    });
    // Rolled up to the block and district as a failing school.
    expect(geoRow(db, 'B1')).toMatchObject({
      nipun_g2_cohort: 12,
      nipun_g3_cohort: 12,
      nipun_school_passed: null,
      nipun_schools_fail: 1,
    });
    expect(geoRow(db, 'D')).toMatchObject({
      nipun_schools_fail: 1,
      nipun_school_passed: null,
    });
  });

  it('a school with fewer than 12 in both bands and no pass is undecidable; counted as insufficient above', async () => {
    const db = new FakeDb();
    seedSchool(db, 'S1', 11, 11, 8);
    const { svc } = makeService(db);
    await svc.run({ full: false, now: NOW });
    expect(geoRow(db, 'S1')).toMatchObject({
      nipun_g2_cohort: 11,
      nipun_g3_cohort: 11,
      nipun_school_passed: null,
      nipun_schools_insufficient: 1,
    });
    expect(geoRow(db, 'D')).toMatchObject({ nipun_schools_insufficient: 1 });
  });

  it('12 seven-year-olds failing g2 with only 6 eight-year-olds is still undecidable (g3 null wins over g2 false)', async () => {
    const db = new FakeDb();
    seedSchool(db, 'S1', 12, 6, 0);
    await makeService(db).svc.run({ full: false, now: NOW });
    expect(geoRow(db, 'S1')).toMatchObject({
      nipun_g2_cohort: 12,
      nipun_g3_cohort: 6,
      nipun_school_passed: null,
      nipun_schools_insufficient: 1,
    });
  });

  it('nine of nine passing g2 passes the band; g3 then decides: 0 of 9 is undecidable, 0 of 12 is a fail', async () => {
    const small = new FakeDb();
    seedSchool(small, 'S1', 9, 9, 9);
    await makeService(small).svc.run({ full: false, now: NOW });
    expect(geoRow(small, 'S1')).toMatchObject({
      nipun_g2_cohort: 9,
      nipun_g3_cohort: 9,
      nipun_school_passed: null, // g2 true, g3 null
      nipun_schools_insufficient: 1,
    });
    expect(geoRow(small, 'S1').metrics.nipun_g2.pass).toBe(9);

    const big = new FakeDb();
    seedSchool(big, 'S1', 9, 12, 9);
    await makeService(big).svc.run({ full: false, now: NOW });
    expect(geoRow(big, 'S1')).toMatchObject({
      nipun_school_passed: false, // g2 true, g3 false
      nipun_schools_fail: 1,
    });
  });

  it('a district counts its schools one-hot: pass, fail and insufficient schools sum up the tree', async () => {
    const db = new FakeDb();
    seedSchool(db, 'S1', 12, 12, 0, 'P'); // fail
    seedSchool(db, 'S2', 5, 5, 0, 'Q'); // insufficient
    seedSchool(db, 'S3', 12, 12, 0, 'R'); // fail
    const { svc } = makeService(db);
    await svc.run({ full: false, now: NOW });
    expect(geoRow(db, 'B1')).toMatchObject({
      nipun_schools_pass: 0,
      nipun_schools_fail: 1,
      nipun_schools_insufficient: 1,
    });
    expect(geoRow(db, 'B2')).toMatchObject({
      nipun_schools_fail: 1,
      nipun_schools_insufficient: 0,
    });
    expect(geoRow(db, 'D')).toMatchObject({
      nipun_schools_pass: 0,
      nipun_schools_fail: 2,
      nipun_schools_insufficient: 1,
    });
  });

  it('students referred straight onto a block count in its cohort but the block gets no school verdict', async () => {
    const db = new FakeDb();
    seedSchool(db, 'B2', 12, 12, 0);
    const { svc } = makeService(db);
    await svc.run({ full: false, now: NOW });
    expect(geoRow(db, 'B2')).toMatchObject({
      nipun_g2_cohort: 12,
      nipun_school_passed: null,
      nipun_schools_pass: 0,
      nipun_schools_fail: 0,
      nipun_schools_insufficient: 0,
    });
    expect(geoRow(db, 'D')).toMatchObject({ nipun_schools_fail: 0 });
    expect(db.geo.some((g) => g.geo_entity_id === 'S3')).toBe(false);
  });

  it('the nightly upsert updates the verdict columns on conflict', async () => {
    const db = new FakeDb();
    seedSchool(db, 'S1', 12, 12, 0);
    const { svc } = makeService(db);
    await svc.run({ full: false, now: NOW });
    const upsert = db.query.mock.calls.find(([sql]) =>
      String(sql).includes('test-results:upsert-geo'),
    )!;
    const sql = String(upsert[0]);
    expect(sql).toMatch(
      /students_unbanded, nipun_g2_cohort, nipun_g3_cohort, nipun_school_passed, nipun_schools_pass, nipun_schools_fail, nipun_schools_insufficient, nipun_g2_n/,
    );
    for (const c of VERDICT_COLUMNS) {
      expect(sql).toContain(`${c} = EXCLUDED.${c}`);
    }
  });
});

describe('TestResultsService.run — usage (active minutes, day before computed_for)', () => {
  // computed_for 2026-09-13 → usage day is 2026-09-12 IST =
  // 2026-09-11T18:30Z … 2026-09-12T18:30Z.
  const at = (iso: string) => new Date(iso);
  const minutesApart = (startIso: string, count: number, gapMin = 1) =>
    Array.from(
      { length: count },
      (_, i) => new Date(at(startIso).getTime() + i * gapMin * 60_000),
    );
  const usageOf = (db: FakeDb, id: string) => {
    const r = db.results.find((x) => x.student_id === id)!;
    return { minutes: r.scores[9], passed: r.scores[10], notes: r.scores[11] };
  };

  it('stores minutes and a strict > 5 pass for students with voice notes that day; nothing for the rest', async () => {
    const db = new FakeDb();
    seed(db);
    db.voiceNotes = new Map([
      // A: 4 notes a minute apart → 3.0 min, fail
      ['A', minutesApart('2026-09-12T04:00:00Z', 4)],
      // B: exactly 5.0 min → still a fail (strictly greater)
      ['B', minutesApart('2026-09-12T04:00:00Z', 6)],
      // G: 7 notes → 6.0 min → pass; a 2-minute silence is not counted
      [
        'G',
        [
          ...minutesApart('2026-09-12T04:00:00Z', 7),
          at('2026-09-12T04:30:00Z'),
        ],
      ],
      // F: only notes on the computed_for day itself (after IST midnight)
      ['F', minutesApart('2026-09-12T18:30:00Z', 3)],
    ]);
    const { svc } = makeService(db);
    await svc.run({ full: false, now: NOW });

    expect(usageOf(db, 'A')).toEqual({ minutes: 3, passed: false, notes: 4 });
    expect(usageOf(db, 'B')).toEqual({ minutes: 5, passed: false, notes: 6 });
    expect(usageOf(db, 'G')).toEqual({ minutes: 6, passed: true, notes: 8 });
    // absence, never a zero
    expect(usageOf(db, 'F')).toEqual({ minutes: null, passed: null, notes: 0 });
    expect(usageOf(db, 'C')).toEqual({ minutes: null, passed: null, notes: 0 });

    // Area: every student counts (unbanded F included), absent = 0 minutes.
    const s1 = db.geo.find(
      (g) => g.geo_entity_id === 'S1' && g.computed_for === COMPUTED_FOR,
    )!.metrics.usage;
    expect(s1).toEqual({
      n: 2,
      sum: '8.000',
      sumsq: '34.0000',
      pass: 0,
      hist: [0, 0, 0, 1, 0, 1, ...Array<number>(25).fill(0)],
    });
    const s3 = db.geo.find(
      (g) => g.geo_entity_id === 'S3' && g.computed_for === COMPUTED_FOR,
    )!.metrics.usage;
    expect(s3.n).toBe(2);
    expect(s3.pass).toBe(1);
    expect(s3.hist[0]).toBe(1); // F: absent → 0
    expect(s3.hist[6]).toBe(1); // G
  });

  it('flow taps are activity events: a tap-only student accrues reading time (298 s allowance) and taps count as attempts', async () => {
    const db = new FakeDb();
    seed(db);
    // A: tap-only (level 11+) — three taps 4 min apart → 8.0 min, pass.
    db.taps = new Map([['A', minutesApart('2026-09-12T04:00:00Z', 3, 4)]]);
    // B: voice notes 4 min apart → over the 120 s voice allowance → 0 min.
    db.voiceNotes = new Map([
      ['B', minutesApart('2026-09-12T04:00:00Z', 3, 4)],
    ]);
    const { svc } = makeService(db);
    await svc.run({ full: false, now: NOW });
    expect(usageOf(db, 'A')).toEqual({ minutes: 8, passed: true, notes: 3 });
    expect(usageOf(db, 'B')).toEqual({ minutes: 0, passed: false, notes: 3 });
  });

  it('a voice note alone (no lesson row) makes a student a candidate', async () => {
    const db = new FakeDb();
    seed(db);
    db.lessons.delete('A');
    db.voiceNotes = new Map([['A', minutesApart('2026-09-12T04:00:00Z', 2)]]);
    const { svc } = makeService(db);
    await svc.run({ full: false, now: NOW });
    expect(usageOf(db, 'A')).toEqual({ minutes: 1, passed: false, notes: 2 });
  });
});

describe('TestResultsService — overlap guard', () => {
  it('refuses to start while a run began less than STALE_RUN_HOURS ago, and ignores a stale one', async () => {
    const db = new FakeDb();
    seed(db);
    const { svc } = makeService(db);
    db.runs.push({
      id: 'live',
      started_at: new Date(Date.now() - 3_600_000),
      full: false,
      status: 'running',
    });
    await expect(svc.run({ full: false, now: NOW })).rejects.toThrow(
      TestRunInProgressError,
    );
    expect(db.runs).toHaveLength(1);

    db.runs[0].started_at = new Date(
      Date.now() - (STALE_RUN_HOURS + 1) * 3_600_000,
    );
    await expect(svc.run({ full: false, now: NOW })).resolves.toEqual(
      expect.objectContaining({ runId: 'run-1' }),
    );
  });

  it('enqueue: 409-shaped result while running or queued, else adds the singleton manual job', async () => {
    const db = new FakeDb();
    const getState = jest.fn();
    const existing = { getState, remove: jest.fn() };
    const queue = { getJob: jest.fn(), add: jest.fn() };
    (createQueue as jest.Mock).mockReturnValue(queue);
    const { svc } = makeService(db);

    db.runs.push({
      id: 'live',
      started_at: new Date(),
      full: false,
      status: 'running',
    });
    expect(await svc.enqueue(false)).toBe('already-running');
    db.runs = [];

    queue.getJob.mockResolvedValue(existing);
    getState.mockResolvedValue('waiting');
    expect(await svc.enqueue(false)).toBe('already-running');

    getState.mockResolvedValue('completed');
    expect(await svc.enqueue(true)).toBe('enqueued');
    expect(existing.remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'test-results-manual',
      { full: true },
      { jobId: 'test-results-manual' },
    );
  });
});

describe('TestResultsService — usage backfill writers', () => {
  function plainService() {
    const query = jest.fn().mockResolvedValue([]);
    const svc = new TestResultsService(
      { query } as unknown as DataSource,
      { ancestors: jest.fn() } as unknown as GeoEntityService,
    );
    return { svc, query };
  }
  const at = new Date('2026-06-01T18:45:00Z');

  it('upsertStudentUsage binds created_at and updates only the usage columns on conflict', async () => {
    const { svc, query } = plainService();
    const n = await svc.upsertStudentUsage(
      [
        { student_id: 'A', geo_entity_id: 'S1', minutes: 5.5, notes: 4 },
        { student_id: 'B', geo_entity_id: null, minutes: 5, notes: 1 },
      ],
      '2026-06-02',
      at,
    );
    expect(n).toBe(2);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('test-results:backfill-students');
    expect(sql).toContain(
      '(student_id, geo_entity_id, computed_for, usage_score, usage_passed, usage_attempts, created_at)',
    );
    expect(sql).toMatch(
      /DO UPDATE SET\s+usage_score = EXCLUDED\.usage_score, usage_passed = EXCLUDED\.usage_passed, usage_attempts = EXCLUDED\.usage_attempts$/,
    );
    expect(sql).not.toMatch(/nipun|mpl_b|created_at = /);
    // pass is strictly > 5 minutes.
    expect(params).toEqual([
      'A',
      'S1',
      '2026-06-02',
      5.5,
      true,
      4,
      at,
      'B',
      null,
      '2026-06-02',
      5,
      false,
      1,
      at,
    ]);
  });

  it('upsertStudentUsage with no rows issues no query', async () => {
    const { svc, query } = plainService();
    expect(await svc.upsertStudentUsage([], '2026-06-02', at)).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('upsertGeoUsage writes created_at and updates only usage_* on conflict', async () => {
    const { svc, query } = plainService();
    const v = emptyVector();
    v.usage = { n: 2, sum: 7, sumsq: 49, pass: 1, hist: v.usage.hist };
    v.students_active = 1;
    const n = await svc.upsertGeoUsage(
      [
        ['S1', v],
        ['B1', v],
      ],
      '2026-06-02',
      at,
    );
    expect(n).toBe(2);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('test-results:backfill-geo');
    expect(sql).toMatch(/usage_hist, created_at\)\s+VALUES/);
    expect(sql).toMatch(
      /DO UPDATE SET usage_n = EXCLUDED\.usage_n, usage_sum = EXCLUDED\.usage_sum, usage_sumsq = EXCLUDED\.usage_sumsq, usage_pass = EXCLUDED\.usage_pass, usage_hist = EXCLUDED\.usage_hist$/,
    );
    expect(sql).not.toMatch(
      /students_active = EXCLUDED|nipun_g2_n = EXCLUDED|created_at = now\(\)/,
    );
    // created_at is bound once and its placeholder closes every row's tuple.
    expect(params.filter((p) => p === at)).toHaveLength(1);
    const slot = `$${params.indexOf(at) + 1}`;
    expect(sql.match(new RegExp(`, \\${slot}\\)`, 'g'))).toHaveLength(2);
    expect(sql.match(/\(\$1, \$2::date/)).not.toBeNull();
    expect(params[0]).toBe('S1');
  });

  it('upsertGeoUsage with no entries issues no query', async () => {
    const { svc, query } = plainService();
    expect(await svc.upsertGeoUsage([], '2026-06-02', at)).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('NIPUN grade 3 pass implies grade 2 at 100 % (roll-up only)', () => {
  const g = (
    nipun_g2_score: number | null,
    nipun_g2_passed: boolean | null,
    nipun_g3_passed: boolean | null,
  ) => impliedNipunG2({ nipun_g2_score, nipun_g2_passed, nipun_g3_passed });

  it('impliedNipunG2: a g3 pass overrides a null or failed g2; anything else passes g2 through', () => {
    expect(g(null, null, true)).toEqual([1, true]); // sped past level 10
    expect(g(0.25, false, true)).toEqual([1, true]); // failed g2, then passed g3
    expect(g(0.75, true, true)).toEqual([0.75, true]); // earned g2 pass kept as scored
    expect(g(null, null, false)).toEqual([null, null]); // failed g3 implies nothing
    expect(g(null, null, null)).toEqual([null, null]); // no g3 implies nothing
    expect(g(0.25, false, false)).toEqual([0.25, false]);
    expect(g(0.25, false, null)).toEqual([0.25, false]);
  });

  it('studentVector: a 7-year-old with no g2 score but a g3 pass is a g2 passer at 1.0; same row at 8 counts for g3 only', () => {
    const row = (birth_year: number): LatestStudentRow => ({
      student_id: 'X',
      geo_entity_id: 'S1',
      birth_year,
      birth_month: 7,
      created_at: null,
      active: true,
      nipun_g2_score: null,
      nipun_g2_passed: null,
      nipun_g3_score: 0.75,
      nipun_g3_passed: true,
      mpl_b_score: null,
      mpl_b_passed: null,
      usage_score: null,
    });
    const on = new Date('2026-09-13T00:00:00Z');
    const seven = studentVector(row(2019), on);
    expect(seven.nipun_g2).toEqual({
      n: 1,
      sum: 1,
      sumsq: 1,
      pass: 1,
      hist: [0, 0, 0, 0, 1],
    });
    expect(seven.nipun_g3.n).toBe(0);
    const eight = studentVector(row(2018), on);
    expect(eight.nipun_g2.n).toBe(0);
    expect(eight.nipun_g3).toMatchObject({ n: 1, sum: 0.75, pass: 1 });
  });

  it('a failed g3 with no g2 contributes nothing to g2 (no implication)', () => {
    const v = studentVector(
      {
        student_id: 'X',
        geo_entity_id: 'S1',
        birth_year: 2019,
        birth_month: 7,
        created_at: null,
        active: true,
        nipun_g2_score: null,
        nipun_g2_passed: null,
        nipun_g3_score: 0.5,
        nipun_g3_passed: false,
        mpl_b_score: null,
        mpl_b_passed: null,
        usage_score: null,
      },
      new Date('2026-09-13T00:00:00Z'),
    );
    expect(v.nipun_g2.n).toBe(0);
    expect(v.students_scored).toBe(1);
  });
});
