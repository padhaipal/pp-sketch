jest.mock('../../interfaces/redis/queues', () => ({
  QUEUE_NAMES: { TEST_RESULTS: 'test-results' },
  createQueue: jest.fn(),
}));

import type { DataSource } from 'typeorm';
import { createQueue } from '../../interfaces/redis/queues';
import {
  addVector,
  emptyVector,
  HIST_LENGTH,
  METRICS,
  STALE_RUN_HOURS,
  STUDENT_BATCH_SIZE,
  studentVector,
  TestResultsService,
  TestRunInProgressError,
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
const ANCESTORS: Record<string, string[]> = {
  S1: ['D', 'B1'],
  S2: ['D', 'B1'],
  S3: ['D', 'B2'],
};

class FakeDb {
  students: Student[] = [];
  lessons = new Map<string, Date[]>();
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
              return (this.lessons.get(s.id) ?? []).some(
                (l) => l.getTime() > latest,
              );
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
        case 'test-results:upsert-students': {
          const created = this.tick();
          for (let i = 0; i < params.length; i += 12) {
            const [student_id, geo_entity_id, computed_for, ...scores] =
              params.slice(i, i + 12) as [
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
                nipun_g2_score: g2s,
                nipun_g2_passed: g2p,
                nipun_g3_score: g3s,
                nipun_g3_passed: g3p,
                mpl_b_score: mbs,
                mpl_b_passed: mbp,
                active: (this.lessons.get(s.id) ?? []).some(
                  (l) => l.getTime() >= since,
                ),
              },
            ];
          });
        }
        case 'test-results:upsert-geo': {
          const per = 5 + METRICS.length * 5;
          for (let i = 0; i < params.length; i += per) {
            const p = params.slice(i, i + per);
            const row: GeoRow = {
              geo_entity_id: p[0] as string,
              computed_for: p[1] as string,
              students_active: p[2] as number,
              students_scored: p[3] as number,
              students_unbanded: p[4] as number,
              metrics: {},
            };
            METRICS.forEach((m, k) => {
              const b = 5 + k * 5;
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
  // birth 2018-07 → age 8 on 2026-09-13: in g2 [7,9), g3 [8,10), mpl_b [8,10).
  db.students = [
    { id: 'A', birth_year: 2018, birth_month: 7, referrer_geo: 'S1' }, // g2 0.75 pass
    { id: 'B', birth_year: 2018, birth_month: 7, referrer_geo: 'S1' }, // g2 0.25 fail
    { id: 'C', birth_year: 2018, birth_month: 7, referrer_geo: 'S2' }, // insufficient → scored=0
    { id: 'E', birth_year: 2010, birth_month: 1, referrer_geo: 'S2' }, // age 16: out of every band
    { id: 'F', birth_year: null, birth_month: null, referrer_geo: 'S3' }, // unbanded
    { id: 'G', birth_year: 2018, birth_month: 7, referrer_geo: 'S3' }, // g2 1.0 pass
    { id: 'H', birth_year: 2018, birth_month: 7, referrer_geo: null }, // no staff referrer → no geo
    {
      id: 'T',
      birth_year: null,
      birth_month: null,
      referrer_geo: 'S1',
      role: 'education_official',
    },
    {
      id: 'X',
      birth_year: 2018,
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
    expect(a.scores).toEqual([0.75, true, 4, null, null, 0, null, null, 0]);
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
      birth_year: 2018,
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
      upserts.map(([, params]) => (params as unknown[]).length / 12),
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
        active: (db.lessons.get(id) ?? []).some(
          (l) => l.getTime() >= COMPUTED_FOR_DATE.getTime() - 14 * 86_400_000,
        ),
        nipun_g2_score: g2s,
        nipun_g2_passed: g2p,
        nipun_g3_score: g3s,
        nipun_g3_passed: g3p,
        mpl_b_score: mbs,
        mpl_b_passed: mbp,
      };
      addVector(v, studentVector(row, COMPUTED_FOR_DATE));
    }
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

    expect(stored(db, 'S1')).toEqual(round(direct(db, ['A', 'B'])));
    expect(stored(db, 'S2')).toEqual(round(direct(db, ['C', 'E'])));
    expect(stored(db, 'S3')).toEqual(round(direct(db, ['F', 'G'])));
    expect(stored(db, 'B1')).toEqual(round(direct(db, ['A', 'B', 'C', 'E'])));
    expect(stored(db, 'B2')).toEqual(round(direct(db, ['F', 'G'])));
    expect(stored(db, 'D')).toEqual(
      round(direct(db, ['A', 'B', 'C', 'E', 'F', 'G'])),
    );
    // …and a block is exactly the sum of its schools.
    expect(stored(db, 'B1')).toEqual(
      addVector(stored(db, 'S1'), stored(db, 'S2')),
    );
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
      pass: 1,
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
