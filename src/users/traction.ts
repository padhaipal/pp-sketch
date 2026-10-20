// Pure assembly of the public traction series (GET users/dashboard/traction,
// the donor page's "Traction" chart). traction.service.ts runs the reads
// and caches the result; everything here is arithmetic over their rows, so
// it is unit-tested without a database. No personal data goes in or out:
// ids are only joined on, never returned.

import { addDays } from '../notifier/report-card/report-card.utils';

// The chart's x-axis starts here (IST calendar date).
export const TRACTION_FROM = '2026-09-01';

export interface TractionDay {
  date: string; // IST YYYY-MM-DD
  // Flows (that IST day):
  users_over_5min: number; // distinct users active > 5 min (active-time.ts gap rule)
  minutes: number; // active minutes over every user, 1 dp
  // Stocks (as of the END of that IST day):
  students_onboarded: number;
  // Students whose latest nightly MPL-B result is a pass (mpl_b_passed —
  // the pass mark literacy-test-scores.ts applies). The nightly row dated
  // D covers everything through 00:15 IST on D, so day X reads rows
  // dated <= X + 1.
  mpl_b_passed: number;
  teachers_onboarded: number;
  // Units with at least one onboarded student (through the student's
  // referrer's geo entity and its ancestors), counted from the first.
  schools: number;
  blocks: number;
  districts: number;
  states: number;
  // The students onboarded THAT day: their mean lifetime active hours up
  // to now, 2 dp; null when nobody was onboarded that day. Recent cohorts
  // have had less time, so the tail is lower by construction.
  cohort_avg_lifetime_hours: number | null;
}

export interface TractionResponse {
  from: string;
  // The last COMPLETE IST day (yesterday when computed).
  to: string;
  computed_at: string;
  daily: TractionDay[];
}

export interface TractionInputs {
  // per IST day: users over 5 min + active ms
  activityByDay: Array<{
    date: string;
    users_over_5min: number;
    active_ms: number;
  }>;
  // lifetime active ms per user
  lifetimeMsByUser: Map<string, number>;
  // onboarded students: IST date of onboarding + the referrer's geo chain
  students: Array<{ id: string; onboarded_on: string; units: UnitRef[] }>;
  // IST dates on which each school-level teacher account was created
  teacherDays: string[];
  // nightly MPL-B results, any order
  mplb: Array<{
    student_id: string;
    computed_for: string;
    passed: boolean | null;
  }>;
}

export interface UnitRef {
  id: string;
  type: string; // geo_entity_type
}

const UNIT_TYPES = ['school', 'block', 'district', 'state'] as const;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

const nextDay = (date: string): string =>
  addDays(new Date(`${date}T00:00:00Z`), 1)
    .toISOString()
    .slice(0, 10);

// IST dates from `from` to `to` inclusive (empty when to < from).
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = nextDay(d)) out.push(d);
  return out;
}

// Running count of first-appearance dates (`dates` may repeat and be in
// any order) at the end of each day of `days`.
function stock(dates: string[], days: string[]): number[] {
  const sorted = [...dates].sort();
  const out: number[] = [];
  let i = 0;
  for (const day of days) {
    while (i < sorted.length && sorted[i] <= day) i++;
    out.push(i);
  }
  return out;
}

export function buildTraction(
  inputs: TractionInputs,
  from: string,
  to: string,
  computedAt: Date,
): TractionResponse {
  const days = dateRange(from, to);
  const activity = new Map(inputs.activityByDay.map((r) => [r.date, r]));

  const students = stock(
    inputs.students.map((s) => s.onboarded_on),
    days,
  );
  const teachers = stock(inputs.teacherDays, days);

  // first onboarded student per unit
  const firstByType = new Map<string, Map<string, string>>(
    UNIT_TYPES.map((t) => [t, new Map<string, string>()]),
  );
  for (const s of inputs.students) {
    for (const u of s.units) {
      const byId = firstByType.get(u.type);
      if (!byId) continue;
      const cur = byId.get(u.id);
      if (cur === undefined || s.onboarded_on < cur)
        byId.set(u.id, s.onboarded_on);
    }
  }
  const unitStock = Object.fromEntries(
    UNIT_TYPES.map((t) => [t, stock([...firstByType.get(t)!.values()], days)]),
  ) as Record<(typeof UNIT_TYPES)[number], number[]>;

  // MPL-B: sweep the nightly rows in date order, keeping each student's
  // latest result; day X is read once every row dated <= X + 1 is applied.
  const mplbRows = [...inputs.mplb].sort((a, b) =>
    a.computed_for < b.computed_for
      ? -1
      : a.computed_for > b.computed_for
        ? 1
        : 0,
  );
  const latest = new Map<string, boolean>();
  let passing = 0;
  let j = 0;
  const mplb: number[] = [];
  for (const day of days) {
    const until = nextDay(day);
    while (j < mplbRows.length && mplbRows[j].computed_for <= until) {
      const r = mplbRows[j++];
      const was = latest.get(r.student_id) === true;
      const now = r.passed === true;
      latest.set(r.student_id, now);
      passing += (now ? 1 : 0) - (was ? 1 : 0);
    }
    mplb.push(passing);
  }

  // cohorts: onboarding day → lifetime hours of its students
  const cohorts = new Map<string, number[]>();
  for (const s of inputs.students) {
    const hours = (inputs.lifetimeMsByUser.get(s.id) ?? 0) / MS_PER_HOUR;
    const c = cohorts.get(s.onboarded_on);
    if (c) c.push(hours);
    else cohorts.set(s.onboarded_on, [hours]);
  }

  const daily: TractionDay[] = days.map((date, k) => {
    const a = activity.get(date);
    const cohort = cohorts.get(date);
    return {
      date,
      users_over_5min: a ? a.users_over_5min : 0,
      minutes: a ? Math.round((a.active_ms / MS_PER_MINUTE) * 10) / 10 : 0,
      students_onboarded: students[k],
      mpl_b_passed: mplb[k],
      teachers_onboarded: teachers[k],
      schools: unitStock.school[k],
      blocks: unitStock.block[k],
      districts: unitStock.district[k],
      states: unitStock.state[k],
      cohort_avg_lifetime_hours: cohort
        ? Math.round(
            (cohort.reduce((x, y) => x + y, 0) / cohort.length) * 100,
          ) / 100
        : null,
    };
  });

  return {
    from,
    to,
    computed_at: computedAt.toISOString(),
    daily,
  };
}
