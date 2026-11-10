/**
 * One-off ASER-proxy backfill: the aser_grade_* columns of
 * test_results_geo_entity (and of the student rows that already exist) for
 * every night before the nightly run knew the metric — and idempotently
 * over nights it did. Each student's ASER level on night D is read from
 * their finished runs before D's 00:15 IST (aserLevelHistory), their age is
 * their age on D, and the area figure is added up exactly as the nightly
 * does (studentVector). Touches nothing but aser_grade_*. Pure over injected
 * I/O; CLI in backfill-aser.main.ts.
 */
import {
  ASER_LEVEL_MAX,
  aserLevelHistory,
  aserStudentPassed,
  type AserLevelPoint,
  type AserTestKey,
  type AserTestScore,
} from '../literacy/aser/aser';
import { ageOn } from '../literacy/score/age-bands';
import {
  addVector,
  emptyVector,
  GeoVector,
  LatestStudentRow,
  STUDENT_BATCH_SIZE,
  StudentAserGradeRow,
  studentVector,
} from '../literacy/score/test-results.service';
import { istDateIso } from '../notifier/report-card/report-card.utils';
import { addDays, nightlyInstant } from './backfill-usage';

export interface BackfillAserDeps {
  log: (message: string) => void;
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  // aser.ts computeAserTestScores — every student's four tests with history.
  aserTests: (
    ids: string[],
  ) => Promise<Map<string, Record<AserTestKey, AserTestScore>>>;
  // GeoEntityService.ancestors — root first, as the nightly consumes it.
  ancestors: (geoId: string) => Promise<Array<{ id: string }>>;
  // TestResultsService writers — the only writes.
  updateStudentAserGrade: (
    rows: StudentAserGradeRow[],
    computedFor: string,
  ) => Promise<void>;
  upsertGeoAserGrade: (
    entries: Array<[string, GeoVector]>,
    computedFor: string,
    createdAt: Date,
  ) => Promise<number>;
}

export interface BackfillAserOptions {
  // Inclusive computed_for range, ISO dates. `from` undefined → the night
  // after the first finished ASER run.
  from?: string;
  to: string;
  dryRun: boolean;
}

export interface BackfillAserSummary {
  students: number; // students with at least one finished ASER run
  days: number;
  studentRows: number; // student-nights offered to the update
  geoRows: number;
  from: string | null;
}

interface StudentRow {
  id: string;
  birth_year: number | null;
  birth_month: number | null;
  created_at: Date | string;
  geo_entity_id: string | null;
}

// The four aser_lN columns that make aserTestLevel read back `level`: the
// level's own test passed (0 → the letter test taken and failed).
export function aserColumnsForLevel(
  level: number,
): Pick<
  LatestStudentRow,
  | 'aser_l1_correct'
  | 'aser_l1_passed'
  | 'aser_l2_correct'
  | 'aser_l2_passed'
  | 'aser_l3_correct'
  | 'aser_l3_passed'
  | 'aser_l4_correct'
  | 'aser_l4_passed'
> {
  const at = (n: number) => (level === n ? 1 : null);
  return {
    aser_l1_correct: level === 0 ? 0 : at(1),
    aser_l1_passed: level === 0 ? false : level === 1 ? true : null,
    aser_l2_correct: at(2),
    aser_l2_passed: level === 2 ? true : null,
    aser_l3_correct: at(3),
    aser_l3_passed: level === 3 ? true : null,
    aser_l4_correct: at(4),
    aser_l4_passed: level === 4 ? true : null,
  };
}

export async function backfillAser(
  deps: BackfillAserDeps,
  options: BackfillAserOptions,
): Promise<BackfillAserSummary> {
  const students = (await deps.query(
    `/* backfill-aser:students */
     SELECT u.id, u.birth_year, u.birth_month, u.created_at, r.geo_entity_id
     FROM users u
     LEFT JOIN users r ON r.id = u.referrer_user_id
     WHERE u.role = 'student' AND u.deleted_at IS NULL
     ORDER BY u.id`,
  )) as StudentRow[];
  const tests = await deps.aserTests(students.map((s) => s.id));
  // Each tested student's level after each finished run, oldest first.
  const history = new Map<string, AserLevelPoint[]>();
  let first: number | null = null;
  for (const s of students) {
    const t = tests.get(s.id);
    const points = t ? aserLevelHistory(t) : [];
    if (points.length === 0) continue;
    history.set(s.id, points);
    const at = points[0].at.getTime();
    if (first === null || at < first) first = at;
  }
  const tested = students.filter((s) => history.has(s.id));
  const summary: BackfillAserSummary = {
    students: tested.length,
    days: 0,
    studentRows: 0,
    geoRows: 0,
    from: null,
  };
  if (first === null) {
    deps.log('no finished ASER runs — nothing to do');
    return summary;
  }
  // The first night whose 00:15 IST run would have seen the first result.
  const from = options.from ?? addDays(istDateIso(new Date(first)), 1);
  summary.from = from;
  if (from > options.to) {
    throw new Error(`from (${from}) is after to (${options.to})`);
  }

  const ancestorCache = new Map<string, string[]>();
  const pathFor = async (geoId: string): Promise<string[]> => {
    let path = ancestorCache.get(geoId);
    if (!path) {
      path = [geoId, ...(await deps.ancestors(geoId)).map((a) => a.id)];
      ancestorCache.set(geoId, path);
    }
    return path;
  };

  for (let d = from; d <= options.to; d = addDays(d, 1)) {
    const cutoff = nightlyInstant(d).getTime();
    const computedForDate = new Date(`${d}T00:00:00Z`);
    const rows: StudentAserGradeRow[] = [];
    const vectors = new Map<string, GeoVector>();
    for (const s of tested) {
      const done = history.get(s.id)!.filter((p) => p.at.getTime() < cutoff);
      if (done.length === 0) continue;
      const level = done[done.length - 1].level;
      const age = ageOn(
        computedForDate,
        s.birth_year,
        s.birth_month,
        s.created_at,
      );
      rows.push({
        student_id: s.id,
        score: level / ASER_LEVEL_MAX,
        passed: aserStudentPassed(level, age),
        attempts: done.length,
      });
      // Area figures: through the referrer's current school, as the nightly.
      if (!s.geo_entity_id) continue;
      const contribution = emptyVector();
      contribution.aser_grade = studentVector(
        {
          student_id: s.id,
          geo_entity_id: s.geo_entity_id,
          birth_year: s.birth_year,
          birth_month: s.birth_month,
          created_at: s.created_at,
          active: false,
          nipun_g1_score: null,
          nipun_g1_passed: null,
          nipun_g2_score: null,
          nipun_g2_passed: null,
          nipun_g3_score: null,
          nipun_g3_passed: null,
          mpl_b_score: null,
          mpl_b_passed: null,
          usage_score: null,
          ...aserColumnsForLevel(level),
        },
        computedForDate,
      ).aser_grade;
      for (const id of await pathFor(s.geo_entity_id)) {
        vectors.set(
          id,
          addVector(vectors.get(id) ?? emptyVector(), contribution),
        );
      }
    }

    const entries = [...vectors.entries()];
    if (!options.dryRun) {
      for (let i = 0; i < rows.length; i += STUDENT_BATCH_SIZE) {
        await deps.updateStudentAserGrade(
          rows.slice(i, i + STUDENT_BATCH_SIZE),
          d,
        );
      }
      await deps.upsertGeoAserGrade(entries, d, nightlyInstant(d));
    }
    summary.days += 1;
    summary.studentRows += rows.length;
    summary.geoRows += entries.length;
    const root = entries.reduce(
      (best, [, v]) => (v.aser_grade.n > best.n ? v.aser_grade : best),
      { n: 0, pass: 0 } as { n: number; pass: number },
    );
    deps.log(
      `${d}${options.dryRun ? ' (dry run)' : ''}: tested=${rows.length} areas=${entries.length} counted=${root.n} passing=${root.pass}`,
    );
  }
  return summary;
}
