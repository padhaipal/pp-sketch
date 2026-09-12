/**
 * Digital-proxy literacy test scores (NIPUN grades 2/3 + MPL-B) — the
 * comprehension query, first-attempt dedup, the three pool filters and the
 * snapshot algorithms, shared by UserService.getLiteracyTestScores (per-user
 * history) and the nightly test-results job (latest point per metric for
 * many students at once). Extracted from user.service.ts in 2026-09; the
 * per-user output is byte-identical (literacy-test-scores.spec.ts golden).
 */
import type {
  LiteracyTestScores,
  SnapshotTestScore,
  TestSnapshotPoint,
} from '../../users/user.dto';

export type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown[]>;

// A student's FIRST attempt at one question. Only first attempts count toward
// tests: once the child has seen the explanation for their tap, any repeat of
// that question is invalidated for testing.
export interface FirstAttempt {
  at: Date;
  correct: boolean;
  question_id: string;
  // The question's level = its passage's media_details.level (the generation
  // pipeline's word-count level), NOT literacy_lesson_states.level (the
  // lesson cap, which can diverge on nearest-level passage fallback).
  level: number | null;
  question_type: string | null;
}

// All tests pass on score STRICTLY greater than 0.5.
export const TEST_PASS_THRESHOLD = 0.5;

export const NIPUN_QUESTION_COUNT = 4;
// NIPUN reading proxies use the retrieve subconstructs only.
export const NIPUN_R1_TYPES = ['R1.1', 'R1.2', 'R1.3'];
export const NIPUN_G2_LEVELS = [10];
export const NIPUN_G3_LEVELS = [11, 12];

// MPL-B selection. Level-13 questions are excluded from every test (and from
// lessons) by construction — only levels 11/12 qualify here.
export const MPL_B_LEVELS = [11, 12];
export const MPL_B_QUESTION_COUNT = 20;
export const MPL_B_MIN_DISTINCT_TYPES = 4;
export const MPL_B_BATCHES: Array<{ types: string[]; required: number }> = [
  { types: ['R1.1', 'R1.2', 'R1.3'], required: 5 },
  { types: ['R2.1', 'R2.2', 'R2.3'], required: 5 },
  { types: ['R3.1', 'R3.2'], required: 1 },
];

export type SnapshotFn = (
  pool: FirstAttempt[],
) => { score: number; passed: boolean } | null;

// NIPUN grade 2/3 snapshot: the most recent `count` first attempts from the
// (already level/type-filtered) pool. Null = insufficient data.
export function nipunSnapshot(
  pool: FirstAttempt[],
  count: number,
): { score: number; passed: boolean } | null {
  if (pool.length < count) return null;
  const selected = pool.slice(-count);
  const score = selected.filter((a) => a.correct).length / count;
  return { score, passed: score > TEST_PASS_THRESHOLD };
}

// MPL-B snapshot over a pool of level-11/12 first attempts (chronological).
// Four filters, walking most-recent-first; one question may satisfy both
// filter two and filter three. Null = insufficient data at any filter.
export function mplBSnapshot(
  pool: FirstAttempt[],
): { score: number; passed: boolean } | null {
  // Filter one: fewer than 20 level-11/12 first attempts → no result.
  if (pool.length < MPL_B_QUESTION_COUNT) return null;
  const recent = [...pool].reverse();
  const selected = new Set<FirstAttempt>();

  // Filter two: most recent representative of each question type until four
  // distinct types are covered; three or fewer distinct types → no result.
  const seenTypes = new Set<string>();
  for (const attempt of recent) {
    if (seenTypes.size >= MPL_B_MIN_DISTINCT_TYPES) break;
    if (attempt.question_type && !seenTypes.has(attempt.question_type)) {
      seenTypes.add(attempt.question_type);
      selected.add(attempt);
    }
  }
  if (seenTypes.size < MPL_B_MIN_DISTINCT_TYPES) return null;

  // Filter three: most recent representatives per batch — R1.x ×5, R2.x ×5,
  // R3.x ×1 (filter-two picks count toward their batch).
  for (const batch of MPL_B_BATCHES) {
    let have = [...selected].filter(
      (a) => a.question_type && batch.types.includes(a.question_type),
    ).length;
    for (const attempt of recent) {
      if (have >= batch.required) break;
      if (
        !selected.has(attempt) &&
        attempt.question_type &&
        batch.types.includes(attempt.question_type)
      ) {
        selected.add(attempt);
        have++;
      }
    }
    if (have < batch.required) return null;
  }

  // Filter four: top up with the most recent remaining attempts to 20
  // (guaranteed reachable — the pool holds at least 20).
  for (const attempt of recent) {
    if (selected.size >= MPL_B_QUESTION_COUNT) break;
    selected.add(attempt);
  }

  const score =
    [...selected].filter((a) => a.correct).length / MPL_B_QUESTION_COUNT;
  return { score, passed: score > TEST_PASS_THRESHOLD };
}

// history[] = the snapshot algorithm replayed over every chronological prefix
// of the pool (insufficient-data prefixes skipped); latest = final entry.
export function snapshotSeries(
  pool: FirstAttempt[],
  snapshot: SnapshotFn,
): SnapshotTestScore {
  const history: TestSnapshotPoint[] = [];
  for (let i = 0; i < pool.length; i++) {
    const result = snapshot(pool.slice(0, i + 1));
    if (result) {
      history.push({
        at: pool[i].at,
        score: result.score,
        passed: result.passed,
      });
    }
  }
  if (history.length === 0) {
    return { status: 'insufficient_data', attempts_available: pool.length };
  }
  return {
    status: 'ok',
    attempts_available: pool.length,
    latest: history[history.length - 1],
    history,
  };
}

// The series' last element in O(n): the snapshot over the whole pool is
// exactly the point the final prefix would produce (or null when the full
// pool is still insufficient — then no prefix could have been sufficient
// either, since every prefix is a subset with the same ordering… except that
// a snapshot can flip from ok to null only by losing rows, which prefixes
// never do). Nightly scoring only needs this point.
export function snapshotLatest(
  pool: FirstAttempt[],
  snapshot: SnapshotFn,
): SnapshotTestScore {
  const result = snapshot(pool);
  if (!result) {
    return { status: 'insufficient_data', attempts_available: pool.length };
  }
  const latest: TestSnapshotPoint = {
    at: pool[pool.length - 1].at,
    score: result.score,
    passed: result.passed,
  };
  return { status: 'ok', attempts_available: pool.length, latest };
}

// ─── Query + pools ───────────────────────────────────────────────────────────

export interface ComprehensionRow {
  user_id: string;
  created_at: Date;
  answer_correct: boolean;
  question_id: string;
  question_type: string | null;
  level: number | null;
}

// Deliberately NO rolled_back filter on these joins (2026-08): a
// retroactively quality-culled passage must not erase the student's
// already-earned comprehension history (NIPUN grades 2/3, MPL-B).
export const COMPREHENSION_ANSWERS_SQL = `
  /* literacy-test-scores:comprehension-answers */
  SELECT s.user_id, s.created_at, s.answer_correct,
         q.id AS question_id,
         q.media_details->>'question_type' AS question_type,
         (p.media_details->>'level')::int AS level
  FROM literacy_lesson_states s
  JOIN media_metadata o ON o.id::text = s.answer
  JOIN media_metadata q ON q.id = o.input_media_id
  JOIN media_metadata p ON p.id = q.input_media_id
  WHERE s.user_id = ANY($1::uuid[])
    AND s.answer_correct IS NOT NULL
    AND (s.snapshot->'context'->>'stateTransitionId')
      LIKE '%-comprehension-complete'
  ORDER BY s.created_at ASC`;

// Dedup to first attempts, in chronological order.
export function dedupeFirstAttempts(rows: ComprehensionRow[]): FirstAttempt[] {
  const seenQuestions = new Set<string>();
  const dedupedAttempts: FirstAttempt[] = [];
  for (const row of rows) {
    if (seenQuestions.has(row.question_id)) continue;
    seenQuestions.add(row.question_id);
    dedupedAttempts.push({
      at: row.created_at,
      correct: row.answer_correct === true,
      question_id: row.question_id,
      level: row.level,
      question_type: row.question_type,
    });
  }
  return dedupedAttempts;
}

export interface MetricPools {
  nipun_g2: FirstAttempt[];
  nipun_g3: FirstAttempt[];
  mpl_b: FirstAttempt[];
}

export function metricPools(attempts: FirstAttempt[]): MetricPools {
  return {
    nipun_g2: attempts.filter(
      (a) =>
        a.level !== null &&
        NIPUN_G2_LEVELS.includes(a.level) &&
        a.question_type !== null &&
        NIPUN_R1_TYPES.includes(a.question_type),
    ),
    nipun_g3: attempts.filter(
      (a) =>
        a.level !== null &&
        NIPUN_G3_LEVELS.includes(a.level) &&
        a.question_type !== null &&
        NIPUN_R1_TYPES.includes(a.question_type),
    ),
    mpl_b: attempts.filter(
      (a) => a.level !== null && MPL_B_LEVELS.includes(a.level),
    ),
  };
}

// Rows for every user in `userIds`, grouped and deduped; users with no
// answers map to an empty list.
export async function fetchFirstAttempts(
  query: QueryFn,
  userIds: string[],
): Promise<Map<string, FirstAttempt[]>> {
  const byUser = new Map<string, ComprehensionRow[]>(
    userIds.map((id) => [id, []]),
  );
  if (userIds.length === 0) return new Map();
  const rows = (await query(COMPREHENSION_ANSWERS_SQL, [
    userIds,
  ])) as ComprehensionRow[];
  for (const row of rows) {
    // A single-user query may come from a caller whose rows carry no
    // user_id (legacy fixtures); attribute them to that one user.
    const key = row.user_id ?? (userIds.length === 1 ? userIds[0] : undefined);
    if (key === undefined) continue;
    const list = byUser.get(key);
    if (list) list.push(row);
  }
  const out = new Map<string, FirstAttempt[]>();
  for (const [id, list] of byUser) out.set(id, dedupeFirstAttempts(list));
  return out;
}

// Per-user history — what GET /users/:id/literacy-test-scores returns.
export function scoresFromAttempts(
  attempts: FirstAttempt[],
): LiteracyTestScores {
  const pools = metricPools(attempts);
  return {
    nipun_grade_2: snapshotSeries(pools.nipun_g2, (prefix) =>
      nipunSnapshot(prefix, NIPUN_QUESTION_COUNT),
    ),
    nipun_grade_3: snapshotSeries(pools.nipun_g3, (prefix) =>
      nipunSnapshot(prefix, NIPUN_QUESTION_COUNT),
    ),
    mpl_b: snapshotSeries(pools.mpl_b, mplBSnapshot),
  };
}

export async function computeLiteracyTestScores(
  query: QueryFn,
  userIds: string[],
): Promise<Map<string, LiteracyTestScores>> {
  const attempts = await fetchFirstAttempts(query, userIds);
  const out = new Map<string, LiteracyTestScores>();
  for (const [id, list] of attempts) out.set(id, scoresFromAttempts(list));
  return out;
}

// ─── Latest point only (nightly job) ─────────────────────────────────────────

export interface LatestMetricScore {
  score: number | null;
  passed: boolean | null;
  attempts: number;
}

export interface LatestLiteracyTestScores {
  nipun_g2: LatestMetricScore;
  nipun_g3: LatestMetricScore;
  mpl_b: LatestMetricScore;
}

function latestOf(result: SnapshotTestScore): LatestMetricScore {
  return {
    score: result.latest?.score ?? null,
    passed: result.latest?.passed ?? null,
    attempts: result.attempts_available,
  };
}

export function latestScoresFromAttempts(
  attempts: FirstAttempt[],
): LatestLiteracyTestScores {
  const pools = metricPools(attempts);
  return {
    nipun_g2: latestOf(
      snapshotLatest(pools.nipun_g2, (p) =>
        nipunSnapshot(p, NIPUN_QUESTION_COUNT),
      ),
    ),
    nipun_g3: latestOf(
      snapshotLatest(pools.nipun_g3, (p) =>
        nipunSnapshot(p, NIPUN_QUESTION_COUNT),
      ),
    ),
    mpl_b: latestOf(snapshotLatest(pools.mpl_b, mplBSnapshot)),
  };
}

export async function computeLatestLiteracyTestScores(
  query: QueryFn,
  userIds: string[],
): Promise<Map<string, LatestLiteracyTestScores>> {
  const attempts = await fetchFirstAttempts(query, userIds);
  const out = new Map<string, LatestLiteracyTestScores>();
  for (const [id, list] of attempts)
    out.set(id, latestScoresFromAttempts(list));
  return out;
}
