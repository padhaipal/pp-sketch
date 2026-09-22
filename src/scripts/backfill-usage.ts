/**
 * One-off usage backfill: test_results_student.usage_* and the usage columns
 * of test_results_geo_entity for every day before the nightly test-results
 * run existed (and idempotently over days it did). Every student gets
 * student rows (so a learner attached to a teacher later brings their
 * history along); school rows come only through a referrer with a school,
 * as in the nightly. Never writes NIPUN/MPL-B. Pure over injected I/O; CLI in backfill-usage.main.ts.
 */
import { activeMs } from '../users/active-time';
import { istDateIso } from '../notifier/report-card/report-card.utils';
import {
  ACTIVE_WINDOW_DAYS,
  addVector,
  emptyVector,
  GeoVector,
  IST_OFFSET_MS,
  STUDENT_BATCH_SIZE,
  StudentUsageRow,
  studentVector,
} from '../literacy/score/test-results.service';

export interface BackfillUsageDeps {
  log: (message: string) => void;
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  // GeoEntityService.ancestors — root first, as the nightly consumes it.
  ancestors: (geoId: string) => Promise<Array<{ id: string }>>;
  // TestResultsService writers — the only writes.
  upsertStudentUsage: (
    rows: StudentUsageRow[],
    computedFor: string,
    createdAt: Date,
  ) => Promise<number>;
  upsertGeoUsage: (
    entries: Array<[string, GeoVector]>,
    computedFor: string,
    createdAt: Date,
  ) => Promise<number>;
}

export interface BackfillUsageOptions {
  // Inclusive computed_for range, ISO dates. A row dated D carries the IST
  // day D−1, exactly as the nightly writes it.
  from: string;
  to: string;
  dryRun: boolean;
}

export interface BackfillUsageSummary {
  students: number;
  days: number;
  studentRows: number;
  geoRows: number;
}

interface StudentRow {
  id: string;
  birth_year: number | null;
  birth_month: number | null;
  created_at: Date | string;
  geo_entity_id: string | null;
}

interface StampRow {
  user_id: string;
  created_at: Date | string;
}

const DAY_MS = 86_400_000;

export function addDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// The instant the nightly would have stamped the row dated D: 00:15 IST.
export function nightlyInstant(computedFor: string): Date {
  return new Date(
    new Date(`${computedFor}T00:00:00Z`).getTime() -
      IST_OFFSET_MS +
      15 * 60_000,
  );
}

export async function backfillUsage(
  deps: BackfillUsageDeps,
  options: BackfillUsageOptions,
): Promise<BackfillUsageSummary> {
  if (options.from > options.to) {
    throw new Error(`from (${options.from}) is after to (${options.to})`);
  }
  const students = (await deps.query(
    `/* backfill-usage:students */
     SELECT u.id, u.birth_year, u.birth_month, u.created_at, r.geo_entity_id
     FROM users u
     LEFT JOIN users r ON r.id = u.referrer_user_id
     WHERE u.role = 'student' AND u.deleted_at IS NULL
     ORDER BY u.id`,
  )) as StudentRow[];
  const ids = students.map((s) => s.id);
  const summary: BackfillUsageSummary = {
    students: students.length,
    days: 0,
    studentRows: 0,
    geoRows: 0,
  };
  if (students.length === 0) {
    deps.log('no students — nothing to do');
    return summary;
  }

  // Voice notes for the whole range in one read, bucketed by (student, IST
  // day). The row dated `from` needs the day before it.
  const noteStart = nightlyInstant(addDays(options.from, -1));
  const noteEnd = nightlyInstant(options.to);
  const notes = (await deps.query(
    `/* backfill-usage:voice-notes */
     SELECT user_id, created_at FROM media_metadata
     WHERE user_id = ANY($1::uuid[])
       AND source = 'whatsapp' AND media_type = 'audio' AND rolled_back = false
       AND created_at >= $2 AND created_at < $3
     ORDER BY user_id, created_at`,
    [ids, noteStart, noteEnd],
  )) as StampRow[];
  const noteTimes = new Map<string, number[]>(); // `${id}|${istDay}` → ms
  for (const n of notes) {
    const at = new Date(n.created_at);
    const key = `${n.user_id}|${istDateIso(at)}`;
    const list = noteTimes.get(key) ?? [];
    list.push(at.getTime());
    noteTimes.set(key, list);
  }

  // Lesson timestamps for students_active (a lesson in the ACTIVE_WINDOW_DAYS
  // before D, and before the nightly instant — never a later one).
  const lessons = (await deps.query(
    `/* backfill-usage:lessons */
     SELECT user_id, created_at FROM literacy_lesson_states
     WHERE user_id = ANY($1::uuid[]) AND created_at < $2
     ORDER BY user_id, created_at`,
    [ids, noteEnd],
  )) as StampRow[];
  const lessonTimes = new Map<string, number[]>();
  for (const l of lessons) {
    const list = lessonTimes.get(l.user_id) ?? [];
    list.push(new Date(l.created_at).getTime());
    lessonTimes.set(l.user_id, list);
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

  for (let d = options.from; d <= options.to; d = addDays(d, 1)) {
    const usageDay = addDays(d, -1);
    const createdAt = nightlyInstant(d);
    const computedForDate = new Date(`${d}T00:00:00Z`);
    const activeSince = computedForDate.getTime() - ACTIVE_WINDOW_DAYS * DAY_MS;

    const rows: StudentUsageRow[] = [];
    const vectors = new Map<string, GeoVector>();
    for (const s of students) {
      const times = noteTimes.get(`${s.id}|${usageDay}`);
      const minutes =
        times === undefined ? null : Math.round(activeMs(times) / 6_000) / 10;
      if (times !== undefined && minutes !== null) {
        rows.push({
          student_id: s.id,
          geo_entity_id: s.geo_entity_id,
          minutes,
          notes: times.length,
        });
      }
      // Geo: every referred student that existed on D, at their referrer's
      // current school. Absent minutes count as zero, as in the nightly.
      if (!s.geo_entity_id) continue;
      if (new Date(s.created_at).getTime() >= createdAt.getTime()) continue;
      const active = (lessonTimes.get(s.id) ?? []).some(
        (t) => t >= activeSince && t < createdAt.getTime(),
      );
      const contribution = studentVector(
        {
          student_id: s.id,
          geo_entity_id: s.geo_entity_id,
          birth_year: s.birth_year,
          birth_month: s.birth_month,
          active,
          nipun_g2_score: null,
          nipun_g2_passed: null,
          nipun_g3_score: null,
          nipun_g3_passed: null,
          mpl_b_score: null,
          mpl_b_passed: null,
          usage_score: minutes,
        },
        computedForDate,
      );
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
        await deps.upsertStudentUsage(
          rows.slice(i, i + STUDENT_BATCH_SIZE),
          d,
          createdAt,
        );
      }
      await deps.upsertGeoUsage(entries, d, createdAt);
    }
    summary.days += 1;
    summary.studentRows += rows.length;
    summary.geoRows += entries.length;
    deps.log(
      `${d}${options.dryRun ? ' (dry run)' : ''}: students=${rows.length} geo=${entries.length}`,
    );
  }
  return summary;
}
