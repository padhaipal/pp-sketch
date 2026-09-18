import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Queue } from 'bullmq';
import { createQueue, QUEUE_NAMES } from '../../interfaces/redis/queues';
import { GeoEntityService } from '../../geo-entities/geo-entity.service';
import { istDateIso } from '../../notifier/report-card/report-card.utils';
import {
  computeLatestLiteracyTestScores,
  LatestLiteracyTestScores,
  MPL_B_QUESTION_COUNT,
  NIPUN_QUESTION_COUNT,
} from './literacy-test-scores';
import { ageOn, inBand, LiteracyMetric, TestMetric } from './age-bands';
import { activeMs } from '../../users/active-time';

// ─── Constants ───────────────────────────────────────────────────────────────

export const TEST_METRICS: readonly TestMetric[] = [
  'nipun_g2',
  'nipun_g3',
  'mpl_b',
];
export const METRICS: readonly LiteracyMetric[] = [...TEST_METRICS, 'usage'];
// Usage — the leading indicator: active minutes (voice-note gap rule,
// users/active-time.ts) on the IST day BEFORE computed_for, i.e. the last
// complete day when the 00:15 IST run starts. Pass is strictly more than
// USAGE_PASS_MINUTES. A day with no voice note is never stored: absence is
// zero, both per student (no usage_score) and per area (counted as 0).
export const USAGE_PASS_MINUTES = 5;
export const USAGE_HIST_MAX_MINUTES = 30; // last bucket: 30+
const IST_OFFSET_MS = 5.5 * 3_600_000;
// Score space is discrete: score × denominator is the histogram index (usage:
// whole minutes, capped at the last bucket).
export const HIST_DENOMINATOR: Record<LiteracyMetric, number> = {
  nipun_g2: NIPUN_QUESTION_COUNT,
  nipun_g3: NIPUN_QUESTION_COUNT,
  mpl_b: MPL_B_QUESTION_COUNT,
  usage: 1,
};
export const HIST_LENGTH: Record<LiteracyMetric, number> = {
  nipun_g2: NIPUN_QUESTION_COUNT + 1,
  nipun_g3: NIPUN_QUESTION_COUNT + 1,
  mpl_b: MPL_B_QUESTION_COUNT + 1,
  usage: USAGE_HIST_MAX_MINUTES + 1,
};
export function histIndex(metric: LiteracyMetric, score: number): number {
  return metric === 'usage'
    ? Math.min(Math.floor(score), USAGE_HIST_MAX_MINUTES)
    : Math.round(score * HIST_DENOMINATOR[metric]);
}
export const STUDENT_BATCH_SIZE = 200;
export const GEO_BATCH_SIZE = 500;
export const ACTIVE_WINDOW_DAYS = 14;
// A 'running' test_runs row older than this is a crashed run, not a live
// one, and must not block tonight.
export const STALE_RUN_HOURS = 6;
export const MANUAL_JOB_ID = 'test-results-manual';

// ─── Vectors (pure; rolled up additively) ────────────────────────────────────

export interface MetricVector {
  n: number;
  sum: number;
  sumsq: number;
  pass: number;
  hist: number[];
}

export interface GeoVector {
  students_active: number;
  students_scored: number;
  students_unbanded: number;
  nipun_g2: MetricVector;
  nipun_g3: MetricVector;
  mpl_b: MetricVector;
  usage: MetricVector;
}

export function emptyVector(): GeoVector {
  const metric = (m: LiteracyMetric): MetricVector => ({
    n: 0,
    sum: 0,
    sumsq: 0,
    pass: 0,
    hist: Array<number>(HIST_LENGTH[m]).fill(0),
  });
  return {
    students_active: 0,
    students_scored: 0,
    students_unbanded: 0,
    nipun_g2: metric('nipun_g2'),
    nipun_g3: metric('nipun_g3'),
    mpl_b: metric('mpl_b'),
    usage: metric('usage'),
  };
}

export function addVector(into: GeoVector, from: GeoVector): GeoVector {
  into.students_active += from.students_active;
  into.students_scored += from.students_scored;
  into.students_unbanded += from.students_unbanded;
  for (const m of METRICS) {
    into[m].n += from[m].n;
    into[m].sum += from[m].sum;
    into[m].sumsq += from[m].sumsq;
    into[m].pass += from[m].pass;
    for (let i = 0; i < into[m].hist.length; i++) {
      into[m].hist[i] += from[m].hist[i];
    }
  }
  return into;
}

// One student's latest row as the geo step reads it.
export interface LatestStudentRow {
  student_id: string;
  geo_entity_id: string | null;
  birth_year: number | null;
  birth_month: number | null;
  active: boolean;
  nipun_g2_score: number | null;
  nipun_g2_passed: boolean | null;
  nipun_g3_score: number | null;
  nipun_g3_passed: boolean | null;
  mpl_b_score: number | null;
  mpl_b_passed: boolean | null;
  // Minutes from the row dated computed_for only (an older row's minutes
  // belong to another day); null → 0.
  usage_score: number | null;
}

// A student's contribution to their school's vector on `computedFor`:
// active/scored flags, unbanded when birth_year is null, and per metric —
// only when the student has a score AND is inside that metric's age band —
// n/sum/sumsq/pass/hist.
export function studentVector(
  row: LatestStudentRow,
  computedFor: Date,
): GeoVector {
  const v = emptyVector();
  v.students_active = row.active ? 1 : 0;
  const scores: Record<TestMetric, [number | null, boolean | null]> = {
    nipun_g2: [row.nipun_g2_score, row.nipun_g2_passed],
    nipun_g3: [row.nipun_g3_score, row.nipun_g3_passed],
    mpl_b: [row.mpl_b_score, row.mpl_b_passed],
  };
  v.students_scored = TEST_METRICS.some((m) => scores[m][0] !== null) ? 1 : 0;
  // Usage counts every student, banded or not: absent minutes are zero.
  const minutes = row.usage_score ?? 0;
  v.usage.n = 1;
  v.usage.sum = minutes;
  v.usage.sumsq = minutes * minutes;
  v.usage.pass = minutes > USAGE_PASS_MINUTES ? 1 : 0;
  v.usage.hist[histIndex('usage', minutes)] = 1;
  const age = ageOn(computedFor, row.birth_year, row.birth_month);
  if (age === null) {
    v.students_unbanded = 1;
    return v;
  }
  for (const m of TEST_METRICS) {
    const [score, passed] = scores[m];
    if (score === null || !inBand(m, age)) continue;
    v[m].n = 1;
    v[m].sum = score;
    v[m].sumsq = score * score;
    v[m].pass = passed ? 1 : 0;
    v[m].hist[histIndex(m, score)] = 1;
  }
  return v;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class TestRunInProgressError extends Error {
  constructor(readonly runId: string) {
    super(`a test-results run is already in progress (${runId})`);
    this.name = 'TestRunInProgressError';
  }
}

export interface RunOptions {
  full: boolean;
  now?: Date;
}

export interface RunSummary {
  runId: string;
  computedFor: string;
  full: boolean;
  candidates: number;
  scored: number;
  geoRows: number;
}

interface CandidateRow {
  id: string;
  birth_year: number | null;
  birth_month: number | null;
  geo_entity_id: string | null;
}

export type EnqueueResult = 'enqueued' | 'already-running';

// Entity service for test_runs, test_results_student and
// test_results_geo_entity: every write to those tables lives here.
@Injectable()
export class TestResultsService {
  private readonly logger = new Logger(TestResultsService.name);
  private queue: Queue | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly geoEntityService: GeoEntityService,
  ) {}

  // ─── Manual trigger ───────────────────────────────────────────────────

  private getQueue(): Queue {
    if (!this.queue) this.queue = createQueue(QUEUE_NAMES.TEST_RESULTS);
    return this.queue;
  }

  async isRunning(): Promise<boolean> {
    const rows: { id: string }[] = await this.dataSource.query(
      `/* test-results:running */
       SELECT id FROM test_runs
       WHERE status = 'running' AND started_at > now() - ($1 || ' hours')::interval
       LIMIT 1`,
      [String(STALE_RUN_HOURS)],
    );
    return rows.length > 0;
  }

  // POST /admin/test-results/run — enqueue a manual run (mirrors
  // MirrorService.enqueue): refused while a run is live in the DB or a manual
  // job is already queued/active.
  async enqueue(full: boolean): Promise<EnqueueResult> {
    if (await this.isRunning()) return 'already-running';
    const queue = this.getQueue();
    const existing = await queue.getJob(MANUAL_JOB_ID);
    if (existing) {
      const state = await existing.getState();
      if (state === 'active' || state === 'waiting' || state === 'delayed') {
        return 'already-running';
      }
      await existing.remove();
    }
    await queue.add('test-results-manual', { full }, { jobId: MANUAL_JOB_ID });
    this.logger.log(`test-results.enqueue full=${String(full)}`);
    return 'enqueued';
  }

  // ─── The run ──────────────────────────────────────────────────────────

  async run(options: RunOptions): Promise<RunSummary> {
    const now = options.now ?? new Date();
    // The IST calendar date at run start: the nightly row dated D
    // summarises everything through 00:15 IST on D; a daytime manual run
    // overwrites today's row via the UNIQUE upsert.
    const computedFor = istDateIso(now);
    const computedForDate = new Date(`${computedFor}T00:00:00Z`);

    if (await this.isRunning()) {
      const rows: { id: string }[] = await this.dataSource.query(
        `SELECT id FROM test_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`,
      );
      throw new TestRunInProgressError(rows[0]?.id ?? 'unknown');
    }

    const [{ id: runId }]: { id: string }[] = await this.dataSource.query(
      `/* test-results:start */
       INSERT INTO test_runs (started_at, "full", status) VALUES ($1, $2, 'running')
       RETURNING id`,
      [now, options.full],
    );
    this.logger.log(
      `test-results.run start run=${runId} computed_for=${computedFor} full=${String(options.full)}`,
    );

    try {
      const candidates = await this.candidates(options.full);
      let scored = 0;
      for (let i = 0; i < candidates.length; i += STUDENT_BATCH_SIZE) {
        const batch = candidates.slice(i, i + STUDENT_BATCH_SIZE);
        scored += await this.scoreBatch(batch, computedFor);
      }
      const geoRows = await this.aggregateGeo(computedFor, computedForDate);
      await this.dataSource.query(
        `/* test-results:finish */
         UPDATE test_runs
         SET finished_at = now(), status = 'ok', students_candidates = $2,
             students_scored = $3, geo_rows = $4
         WHERE id = $1`,
        [runId, candidates.length, scored, geoRows],
      );
      const summary: RunSummary = {
        runId,
        computedFor,
        full: options.full,
        candidates: candidates.length,
        scored,
        geoRows,
      };
      this.logger.log(
        `test-results.run ok run=${runId} candidates=${candidates.length} scored=${scored} geo_rows=${geoRows}`,
      );
      return summary;
    } catch (err) {
      await this.dataSource.query(
        `/* test-results:fail */
         UPDATE test_runs SET finished_at = now(), status = 'failed', error = $2
         WHERE id = $1`,
        [runId, (err as Error).message],
      );
      this.logger.error(
        `test-results.run failed run=${runId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  // Students with a lesson row newer than their latest test_results_student
  // row (or with no row yet). NOT "activity since midnight": a student
  // missed by a failed night is picked up the next night. `full` takes
  // everyone (after a retroactive passage edit).
  private async candidates(full: boolean): Promise<CandidateRow[]> {
    return await this.dataSource.query(
      `/* test-results:candidates */
       SELECT u.id, u.birth_year, u.birth_month, r.geo_entity_id
       FROM users u
       LEFT JOIN users r ON r.id = u.referrer_user_id
       WHERE u.role = 'student' AND u.deleted_at IS NULL
         AND ($1::boolean OR EXISTS (
           SELECT 1 FROM literacy_lesson_states l
           WHERE l.user_id = u.id
             AND l.created_at > COALESCE(
               (SELECT max(t.created_at) FROM test_results_student t WHERE t.student_id = u.id),
               '-infinity'::timestamptz))
           OR EXISTS (
           SELECT 1 FROM media_metadata m
           WHERE m.user_id = u.id AND m.source = 'whatsapp' AND m.media_type = 'audio'
             AND m.rolled_back = false
             AND m.created_at > COALESCE(
               (SELECT max(t.created_at) FROM test_results_student t WHERE t.student_id = u.id),
               '-infinity'::timestamptz)))
       ORDER BY u.id`,
      [full],
    );
  }

  private async scoreBatch(
    batch: CandidateRow[],
    computedFor: string,
  ): Promise<number> {
    const scores = await computeLatestLiteracyTestScores(
      (sql, params) => this.dataSource.query(sql, params),
      batch.map((c) => c.id),
    );
    const usage = await this.usageForBatch(
      batch.map((c) => c.id),
      computedFor,
    );
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    const push = (v: unknown) => {
      params.push(v);
      return `$${++p}`;
    };
    for (const c of batch) {
      const s: LatestLiteracyTestScores = scores.get(c.id) ?? {
        nipun_g2: { score: null, passed: null, attempts: 0 },
        nipun_g3: { score: null, passed: null, attempts: 0 },
        mpl_b: { score: null, passed: null, attempts: 0 },
      };
      const u = usage.get(c.id) ?? { minutes: null, notes: 0 };
      values.push(
        `(${push(c.id)}, ${push(c.geo_entity_id)}, ${push(computedFor)}::date, ` +
          `${push(s.nipun_g2.score)}, ${push(s.nipun_g2.passed)}, ${push(s.nipun_g2.attempts)}, ` +
          `${push(s.nipun_g3.score)}, ${push(s.nipun_g3.passed)}, ${push(s.nipun_g3.attempts)}, ` +
          `${push(s.mpl_b.score)}, ${push(s.mpl_b.passed)}, ${push(s.mpl_b.attempts)}, ` +
          `${push(u.minutes)}, ${push(u.minutes === null ? null : u.minutes > USAGE_PASS_MINUTES)}, ${push(u.notes)})`,
      );
    }
    if (values.length === 0) return 0;
    await this.dataSource.query(
      `/* test-results:upsert-students */
       INSERT INTO test_results_student
         (student_id, geo_entity_id, computed_for,
          nipun_g2_score, nipun_g2_passed, nipun_g2_attempts,
          nipun_g3_score, nipun_g3_passed, nipun_g3_attempts,
          mpl_b_score, mpl_b_passed, mpl_b_attempts,
          usage_score, usage_passed, usage_attempts)
       VALUES ${values.join(',\n')}
       ON CONFLICT (student_id, computed_for) DO UPDATE SET
         geo_entity_id = EXCLUDED.geo_entity_id,
         nipun_g2_score = EXCLUDED.nipun_g2_score, nipun_g2_passed = EXCLUDED.nipun_g2_passed, nipun_g2_attempts = EXCLUDED.nipun_g2_attempts,
         nipun_g3_score = EXCLUDED.nipun_g3_score, nipun_g3_passed = EXCLUDED.nipun_g3_passed, nipun_g3_attempts = EXCLUDED.nipun_g3_attempts,
         mpl_b_score = EXCLUDED.mpl_b_score, mpl_b_passed = EXCLUDED.mpl_b_passed, mpl_b_attempts = EXCLUDED.mpl_b_attempts,
         usage_score = EXCLUDED.usage_score, usage_passed = EXCLUDED.usage_passed, usage_attempts = EXCLUDED.usage_attempts,
         created_at = now()`,
      params,
    );
    return batch.length;
  }

  // Active minutes per student on the IST day before `computedFor`, from
  // their WhatsApp voice notes. Students with no note that day are absent
  // from the map (never a zero row).
  private async usageForBatch(
    ids: string[],
    computedFor: string,
  ): Promise<Map<string, { minutes: number; notes: number }>> {
    const dayEnd = new Date(
      new Date(`${computedFor}T00:00:00Z`).getTime() - IST_OFFSET_MS,
    );
    const dayStart = new Date(dayEnd.getTime() - 86_400_000);
    const rows: Array<{ user_id: string; created_at: Date | string }> =
      await this.dataSource.query(
        `/* test-results:voice-notes */
         SELECT user_id, created_at FROM media_metadata
         WHERE user_id = ANY($1::uuid[])
           AND source = 'whatsapp' AND media_type = 'audio' AND rolled_back = false
           AND created_at >= $2 AND created_at < $3
         ORDER BY user_id, created_at`,
        [ids, dayStart, dayEnd],
      );
    const times = new Map<string, number[]>();
    for (const r of rows) {
      const list = times.get(r.user_id) ?? [];
      list.push(new Date(r.created_at).getTime());
      times.set(r.user_id, list);
    }
    return new Map(
      [...times].map(([id, t]) => [
        id,
        { minutes: Math.round(activeMs(t) / 6_000) / 10, notes: t.length },
      ]),
    );
  }

  // Every student's LATEST row (most were skipped tonight, so tonight's rows
  // alone would give wrong totals), joined to the referrer's CURRENT geo
  // entity. Schools get a vector each; ancestors get the element-wise sum of
  // their schools' vectors — never a re-read of student rows.
  private async aggregateGeo(
    computedFor: string,
    computedForDate: Date,
  ): Promise<number> {
    const activeSince = new Date(
      computedForDate.getTime() - ACTIVE_WINDOW_DAYS * 86_400_000,
    );
    const rows: LatestStudentRow[] = await this.dataSource.query(
      `/* test-results:latest-students */
       SELECT DISTINCT ON (t.student_id)
              t.student_id, r.geo_entity_id, u.birth_year, u.birth_month,
              t.nipun_g2_score::float8 AS nipun_g2_score, t.nipun_g2_passed,
              t.nipun_g3_score::float8 AS nipun_g3_score, t.nipun_g3_passed,
              t.mpl_b_score::float8 AS mpl_b_score, t.mpl_b_passed,
              CASE WHEN t.computed_for = $2::date THEN t.usage_score::float8 END AS usage_score,
              EXISTS (SELECT 1 FROM literacy_lesson_states l
                      WHERE l.user_id = t.student_id AND l.created_at >= $1) AS active
       FROM test_results_student t
       JOIN users u ON u.id = t.student_id
       LEFT JOIN users r ON r.id = u.referrer_user_id
       WHERE u.role = 'student' AND u.deleted_at IS NULL
       ORDER BY t.student_id, t.created_at DESC`,
      [activeSince, computedFor],
    );

    const vectors = new Map<string, GeoVector>();
    const ancestorCache = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.geo_entity_id) continue;
      const contribution = studentVector(row, computedForDate);
      let path = ancestorCache.get(row.geo_entity_id);
      if (!path) {
        const ancestors = await this.geoEntityService.ancestors(
          row.geo_entity_id,
        );
        path = [row.geo_entity_id, ...ancestors.map((a) => a.id)];
        ancestorCache.set(row.geo_entity_id, path);
      }
      for (const id of path) {
        const v = vectors.get(id) ?? emptyVector();
        vectors.set(id, addVector(v, contribution));
      }
    }

    const entries = [...vectors.entries()];
    for (let i = 0; i < entries.length; i += GEO_BATCH_SIZE) {
      await this.upsertGeoRows(
        entries.slice(i, i + GEO_BATCH_SIZE),
        computedFor,
      );
    }
    return entries.length;
  }

  private async upsertGeoRows(
    entries: Array<[string, GeoVector]>,
    computedFor: string,
  ): Promise<void> {
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    const push = (v: unknown) => {
      params.push(v);
      return `$${++p}`;
    };
    for (const [geoId, v] of entries) {
      // Bind in column order: key columns, counts, then each metric's
      // n/sum/sumsq/pass/hist.
      const head = [
        push(geoId),
        `${push(computedFor)}::date`,
        push(v.students_active),
        push(v.students_scored),
        push(v.students_unbanded),
      ];
      const metricCols = METRICS.map(
        (m) =>
          `${push(v[m].n)}, ${push(v[m].sum.toFixed(3))}, ${push(v[m].sumsq.toFixed(4))}, ${push(v[m].pass)}, ${push(v[m].hist)}::integer[]`,
      );
      values.push(`(${[...head, ...metricCols].join(', ')})`);
    }
    const metricColumnNames = METRICS.flatMap((m) => [
      `${m}_n`,
      `${m}_sum`,
      `${m}_sumsq`,
      `${m}_pass`,
      `${m}_hist`,
    ]);
    const setClause = [
      'students_active',
      'students_scored',
      'students_unbanded',
      ...metricColumnNames,
    ]
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(', ');
    await this.dataSource.query(
      `/* test-results:upsert-geo */
       INSERT INTO test_results_geo_entity
         (geo_entity_id, computed_for, students_active, students_scored, students_unbanded, ${metricColumnNames.join(', ')})
       VALUES ${values.join(',\n')}
       ON CONFLICT (geo_entity_id, computed_for) DO UPDATE SET ${setClause}, created_at = now()`,
      params,
    );
  }
}
