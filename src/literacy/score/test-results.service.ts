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
import {
  ACTIVITY_EVENT_SQL,
  IS_TAP_SQL,
  activeMs,
  type ActivityEvent,
} from '../../users/active-time';

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
export const IST_OFFSET_MS = 5.5 * 3_600_000;
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
// test_results_geo_entity columns of the school verdict, in bind order.
export const VERDICT_COLUMNS = [
  'nipun_g2_cohort',
  'nipun_g3_cohort',
  'nipun_school_passed',
  'nipun_schools_pass',
  'nipun_schools_fail',
  'nipun_schools_insufficient',
] as const;
export const ACTIVE_WINDOW_DAYS = 14;
// A 'running' test_runs row older than this is a crashed run, not a live
// one, and must not block tonight.
export const STALE_RUN_HOURS = 6;
export const MANUAL_JOB_ID = 'test-results-manual';
// School-level NIPUN verdict (schoolVerdict): a band passes when at least
// NIPUN_SCHOOL_MIN_PASSERS of its cohort pass AND they are at least
// NIPUN_SCHOOL_PASS_SHARE of the cohort (inclusive); a band that doesn't
// pass is a fail only with at least NIPUN_SCHOOL_MIN_COHORT students,
// otherwise undecidable. The cohort is EVERY student of the school inside
// the band's age range, scored or not.
export const NIPUN_SCHOOL_MIN_PASSERS = 9;
export const NIPUN_SCHOOL_PASS_SHARE = 0.75;
export const NIPUN_SCHOOL_MIN_COHORT = 12;

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
  // Students inside the band's age range, scored or not (additive).
  nipun_g2_cohort: number;
  nipun_g3_cohort: number;
  // School rows only; null on ancestors and when undecidable. Never summed.
  nipun_school_passed: boolean | null;
  // Schools below (or this school, one-hot) by verdict (additive).
  nipun_schools_pass: number;
  nipun_schools_fail: number;
  nipun_schools_insufficient: number;
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
    nipun_g2_cohort: 0,
    nipun_g3_cohort: 0,
    nipun_school_passed: null,
    nipun_schools_pass: 0,
    nipun_schools_fail: 0,
    nipun_schools_insufficient: 0,
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
  into.nipun_g2_cohort += from.nipun_g2_cohort;
  into.nipun_g3_cohort += from.nipun_g3_cohort;
  into.nipun_schools_pass += from.nipun_schools_pass;
  into.nipun_schools_fail += from.nipun_schools_fail;
  into.nipun_schools_insufficient += from.nipun_schools_insufficient;
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
  // users.created_at — the onboarding day the age rule estimates a missing
  // birth month from (age-bands.ts assumedBirth).
  created_at: Date | string | null;
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
  const age = ageOn(
    computedFor,
    row.birth_year,
    row.birth_month,
    row.created_at,
  );
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

// One student of a school as the cohort step reads it: every non-deleted
// student with a birth year whose referrer has a geo entity, whether or not
// they have ever been scored.
export interface CohortRow {
  geo_entity_id: string;
  birth_year: number | null;
  birth_month: number | null;
  created_at: Date | string | null;
}

// A student's cohort contribution on `computedFor`: 1 per NIPUN band whose
// age range holds them (the bands overlap, so both is possible).
export function cohortVector(row: CohortRow, computedFor: Date): GeoVector {
  const v = emptyVector();
  const age = ageOn(
    computedFor,
    row.birth_year,
    row.birth_month,
    row.created_at,
  );
  if (inBand('nipun_g2', age)) v.nipun_g2_cohort = 1;
  if (inBand('nipun_g3', age)) v.nipun_g3_cohort = 1;
  return v;
}

// One band: true = passes, false = fails, null = too few students to say.
export function bandVerdict(cohort: number, pass: number): boolean | null {
  if (
    pass >= NIPUN_SCHOOL_MIN_PASSERS &&
    pass >= NIPUN_SCHOOL_PASS_SHARE * cohort
  ) {
    return true;
  }
  return cohort >= NIPUN_SCHOOL_MIN_COHORT ? false : null;
}

// A school passes NIPUN when both bands pass; is undecidable when either
// band is; fails otherwise. Reads the school's own finished vector.
export function schoolVerdict(v: GeoVector): boolean | null {
  const g2 = bandVerdict(v.nipun_g2_cohort, v.nipun_g2.pass);
  const g3 = bandVerdict(v.nipun_g3_cohort, v.nipun_g3.pass);
  if (g2 === true && g3 === true) return true;
  if (g2 === null || g3 === null) return null;
  return false;
}

// The one-hot school count a verdict adds to the school and its ancestors.
export function verdictVector(passed: boolean | null): GeoVector {
  const v = emptyVector();
  if (passed === true) v.nipun_schools_pass = 1;
  else if (passed === false) v.nipun_schools_fail = 1;
  else v.nipun_schools_insufficient = 1;
  return v;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class TestRunInProgressError extends Error {
  constructor(readonly runId: string) {
    super(`a test-results run is already in progress (${runId})`);
    this.name = 'TestRunInProgressError';
  }
}

// One backfilled student-day (upsertStudentUsage).
export interface StudentUsageRow {
  student_id: string;
  geo_entity_id: string | null;
  minutes: number;
  notes: number;
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
  // their activity events (WhatsApp voice notes + comprehension flow taps —
  // users/active-time.ts). `notes` counts both. Students with no event that
  // day are absent from the map (never a zero row).
  private async usageForBatch(
    ids: string[],
    computedFor: string,
  ): Promise<Map<string, { minutes: number; notes: number }>> {
    const dayEnd = new Date(
      new Date(`${computedFor}T00:00:00Z`).getTime() - IST_OFFSET_MS,
    );
    const dayStart = new Date(dayEnd.getTime() - 86_400_000);
    const rows: Array<{
      user_id: string;
      created_at: Date | string;
      tap: boolean;
    }> = await this.dataSource.query(
      `/* test-results:voice-notes */
         SELECT user_id, created_at, ${IS_TAP_SQL()} AS tap FROM media_metadata
         WHERE user_id = ANY($1::uuid[])
           AND ${ACTIVITY_EVENT_SQL()}
           AND created_at >= $2 AND created_at < $3
         ORDER BY user_id, created_at`,
      [ids, dayStart, dayEnd],
    );
    const times = new Map<string, ActivityEvent[]>();
    for (const r of rows) {
      const list = times.get(r.user_id) ?? [];
      list.push({ at: new Date(r.created_at).getTime(), tap: r.tap === true });
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
              t.student_id, r.geo_entity_id, u.birth_year, u.birth_month, u.created_at,
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
    // Leaf (the referrer's geo entity) → [leaf, ...ancestors]; one ancestors()
    // read per leaf, never per student.
    const ancestorCache = new Map<string, string[]>();
    const pathFor = async (leafId: string): Promise<string[]> => {
      let path = ancestorCache.get(leafId);
      if (!path) {
        const ancestors = await this.geoEntityService.ancestors(leafId);
        path = [leafId, ...ancestors.map((a) => a.id)];
        ancestorCache.set(leafId, path);
      }
      return path;
    };
    const addAlong = (path: string[], contribution: GeoVector) => {
      for (const id of path) {
        const v = vectors.get(id) ?? emptyVector();
        vectors.set(id, addVector(v, contribution));
      }
    };
    for (const row of rows) {
      if (!row.geo_entity_id) continue;
      addAlong(
        await pathFor(row.geo_entity_id),
        studentVector(row, computedForDate),
      );
    }

    // Cohort: every student of the school in a NIPUN band's age range,
    // scored or not — the verdict's denominator. Same membership join as
    // latest-students (referrer's CURRENT geo entity), minus the results row.
    const cohort: CohortRow[] = await this.dataSource.query(
      `/* test-results:cohort */
       SELECT r.geo_entity_id, u.birth_year, u.birth_month, u.created_at
       FROM users u
       JOIN users r ON r.id = u.referrer_user_id
       WHERE u.role = 'student' AND u.deleted_at IS NULL
         AND u.birth_year IS NOT NULL AND r.geo_entity_id IS NOT NULL`,
    );
    for (const row of cohort) {
      addAlong(
        await pathFor(row.geo_entity_id),
        cohortVector(row, computedForDate),
      );
    }

    // Verdict: only for leaves that are schools (a referrer attached to a
    // block puts their students straight on the block, which is no school).
    // Each school's verdict is read off its finished vector, then counted
    // one-hot on the school and every ancestor.
    const leafIds = [...ancestorCache.keys()];
    const leafTypes: Array<{ id: string; type: string }> = leafIds.length
      ? await this.dataSource.query(
          `/* test-results:leaf-types */
           SELECT id, type FROM geo_entity WHERE id = ANY($1::uuid[])`,
          [leafIds],
        )
      : [];
    for (const { id, type } of leafTypes) {
      if (type !== 'school') continue;
      const school = vectors.get(id);
      if (!school) continue;
      const passed = schoolVerdict(school);
      school.nipun_school_passed = passed;
      addAlong(await pathFor(id), verdictVector(passed));
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

  // ─── Usage backfill (src/scripts/backfill-usage.ts) ───────────────────
  // Historical rows for days the nightly never saw. Both writers touch ONLY
  // the usage columns on conflict (NIPUN/MPL-B stay whatever the nightly
  // wrote, NULL on rows created here) and bind created_at to the historical
  // instant rather than now(): aggregateGeo picks each student's latest row
  // by created_at and candidates() compares activity against it, so a
  // backfilled row stamped now() would shadow tonight's real scores.

  async upsertStudentUsage(
    rows: StudentUsageRow[],
    computedFor: string,
    createdAt: Date,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    const push = (v: unknown) => {
      params.push(v);
      return `$${++p}`;
    };
    for (const r of rows) {
      values.push(
        `(${push(r.student_id)}, ${push(r.geo_entity_id)}, ${push(computedFor)}::date, ` +
          `${push(r.minutes)}, ${push(r.minutes > USAGE_PASS_MINUTES)}, ${push(r.notes)}, ${push(createdAt)})`,
      );
    }
    await this.dataSource.query(
      `/* test-results:backfill-students */
       INSERT INTO test_results_student
         (student_id, geo_entity_id, computed_for, usage_score, usage_passed, usage_attempts, created_at)
       VALUES ${values.join(',\n')}
       ON CONFLICT (student_id, computed_for) DO UPDATE SET
         usage_score = EXCLUDED.usage_score, usage_passed = EXCLUDED.usage_passed, usage_attempts = EXCLUDED.usage_attempts`,
      params,
    );
    return rows.length;
  }

  async upsertGeoUsage(
    entries: Array<[string, GeoVector]>,
    computedFor: string,
    createdAt: Date,
  ): Promise<number> {
    for (let i = 0; i < entries.length; i += GEO_BATCH_SIZE) {
      await this.upsertGeoRows(
        entries.slice(i, i + GEO_BATCH_SIZE),
        computedFor,
        {
          usageOnly: true,
          createdAt,
        },
      );
    }
    return entries.length;
  }

  private async upsertGeoRows(
    entries: Array<[string, GeoVector]>,
    computedFor: string,
    backfill?: { usageOnly: true; createdAt: Date },
  ): Promise<void> {
    if (entries.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    const push = (v: unknown) => {
      params.push(v);
      return `$${++p}`;
    };
    for (const [geoId, v] of entries) {
      // Bind in column order: key columns, counts, NIPUN school verdict
      // columns, then each metric's n/sum/sumsq/pass/hist.
      const head = [
        push(geoId),
        `${push(computedFor)}::date`,
        push(v.students_active),
        push(v.students_scored),
        push(v.students_unbanded),
        push(v.nipun_g2_cohort),
        push(v.nipun_g3_cohort),
        push(v.nipun_school_passed),
        push(v.nipun_schools_pass),
        push(v.nipun_schools_fail),
        push(v.nipun_schools_insufficient),
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
    const updatable = backfill
      ? metricColumnNames.filter((c) => c.startsWith('usage_'))
      : [
          'students_active',
          'students_scored',
          'students_unbanded',
          ...VERDICT_COLUMNS,
          ...metricColumnNames,
        ];
    const setClause = updatable.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
    const createdAtCol = backfill ? ', created_at' : '';
    const createdAtVal = backfill ? `, ${push(backfill.createdAt)}` : '';
    const createdAtSet = backfill ? '' : ', created_at = now()';
    // values were built before createdAtVal bound its parameter, so append it
    // to every row here rather than inside the loop above.
    const rowsSql = backfill
      ? values.map((v) => `${v.slice(0, -1)}${createdAtVal})`).join(',\n')
      : values.join(',\n');
    await this.dataSource.query(
      `/* test-results:${backfill ? 'backfill-geo' : 'upsert-geo'} */
       INSERT INTO test_results_geo_entity
         (geo_entity_id, computed_for, students_active, students_scored, students_unbanded, ${VERDICT_COLUMNS.join(', ')}, ${metricColumnNames.join(', ')}${createdAtCol})
       VALUES ${rowsSql}
       ON CONFLICT (geo_entity_id, computed_for) DO UPDATE SET ${setClause}${createdAtSet}`,
      params,
    );
  }
}
