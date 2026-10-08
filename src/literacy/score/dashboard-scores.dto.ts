import { BadRequestException } from '@nestjs/common';
import { METRIC_AGE_BANDS, type LiteracyMetric } from './age-bands';
import {
  MPL_B_PASS_THRESHOLD,
  NIPUN_PASS_THRESHOLD,
} from './literacy-test-scores';
import type { GeoEntityType } from '../../geo-entities/geo-entity.dto';
import type { PiiVisibility } from '../../users/pii-mask';

export const DASHBOARD_METRICS: readonly LiteracyMetric[] = [
  'usage',
  'nipun_g2',
  'nipun_g3',
  'mpl_b',
];
// 30 = the last 30 days; 'all' = all time (no lower bound on the series;
// deltas compare against the OLDEST row instead of a row ≤ as_of − range).
export const DASHBOARD_RANGES = [30, 'all'] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];
export const DEFAULT_RANGE: DashboardRange = 30;
// "Time" (the usage metric) over a window of stored days. Optional on the
// wire: a request WITHOUT `window` gets the pre-2026-10 usage response
// (yesterday's share of students over 5 min, deltas, most improved) so an
// older dashboard keeps working; with it the response carries the time_*
// fields below and no deltas / most improved.
//   yesterday = the last complete IST day (the row dated as_of)
//   7d        = the last seven days (rows dated as_of−6 … as_of)
//   all       = every stored day up to as_of
export const TIME_WINDOWS = ['yesterday', '7d', 'all'] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];
export const TIME_WINDOW_DAYS: Record<TimeWindow, number | null> = {
  yesterday: 1,
  '7d': 7,
  all: null,
};
// Colour rule for an average of minutes per day — the same 5-minute mark the
// daily-usage pass uses (strictly more than).
export const TIME_PASS_MINUTES_PER_DAY = 5;
export const MOST_IMPROVED_MIN_N = 5;
export const MOST_IMPROVED_LIMIT = 5;
export const ACTIVE_WINDOW_DAYS = 14;
// Dashboard responses are cached for five minutes: the data changes once a
// night and these are the heaviest queries in the app. `private`, because
// the same URL answers differently per viewer (dashboard-scores.pii.ts) and
// must never be served from a shared cache.
export const PUBLIC_CACHE_CONTROL = 'private, max-age=300';

export type ChildType =
  | 'state'
  | 'district'
  | 'block'
  | 'school'
  | 'teacher'
  | 'student';

// The child level below each root type. A school's children are its
// TEACHERS (the referrers of its students); a teacher's children — reached
// by passing the teacher's user id as `:id` — are their students.
export const CHILD_TYPE_OF: Record<GeoEntityType, ChildType | null> = {
  country: 'state',
  state: 'district',
  district: 'block',
  block: 'school',
  school: 'teacher',
  cluster: null,
};

export interface GeoRef {
  id: string;
  // 'teacher' = a referrer user standing in as the school's child level
  // (id = users.id, code '', no coordinates).
  type: GeoEntityType | 'teacher';
  code: string;
  name: string;
  has_boundary: boolean;
  lat: number | null;
  lng: number | null;
  // Schools only (UDISE management): government | government_aided |
  // private | other; absent/null elsewhere. The map draws private schools
  // with a different marker.
  management_group?:
    | 'government'
    | 'government_aided'
    | 'private'
    | 'other'
    | null;
}

// Active time over the requested window (usage metric with `window` only).
// A student's own figures; for an area, a teacher or a class they are PER
// STUDENT (so areas of different sizes compare): `time_per_day` = minutes
// per student per day, `time_total` = minutes per student over the window.
export interface TimeFields {
  // Minutes in the window, 1 dp. Null when there is nothing to average.
  time_total?: number | null;
  // Minutes per day, 1 dp — what the colour follows.
  time_per_day?: number | null;
  // The days the figures cover (1, up to 7, or the stored history).
  time_days?: number;
}

export interface RootStats extends TimeFields {
  pass_rate: number | null;
  mean: number | null;
  sd: number | null;
  n: number | null;
  students_active: number | null;
  students_unbanded: number | null;
  delta: number | null;
}

export interface SeriesPoint {
  date: string;
  pass_rate: number | null;
  n: number;
  // usage: mean minutes per student that day (absent students = 0);
  // tests: mean score × 100 over the scored students; null at n = 0.
  mean: number | null;
}

// Class level only: one line per student for the trend chart. `value` is
// minutes for usage (no row that day → 0) and score × 100 for the tests
// (no row → null, a gap in the line).
export interface StudentSeriesPoint {
  date: string;
  value: number | null;
}
export interface StudentSeries {
  student_id: string;
  points: StudentSeriesPoint[];
}
// Geo and school levels: one line per child (an area, or a teacher's class)
// for the trend chart — the child's mean (score × 100, or minutes per
// student for usage) on each stored date.
export interface ChildSeries {
  id: string;
  points: StudentSeriesPoint[];
}

export type Bin = 'high' | 'mid' | 'low' | 'none';

export interface Official {
  // users.id — what PiiAccessService decides visibility by.
  id: string;
  name: string | null;
  role_title: string | null;
  avatar_seed: string | null;
  spotlight_message: string | null;
  // The official's WhatsApp number (users.external_id), in full only for
  // the viewer directly above them in the hierarchy; masked otherwise.
  phone: string | null;
  pii: PiiVisibility;
}

export interface ChildRow extends GeoRef, TimeFields {
  pass_rate: number | null;
  n: number;
  students_active: number;
  using_lifteracy: boolean;
  delta: number | null;
  bin: Bin;
  official: Official | null;
  // Teacher rows only: how many students the teacher referred.
  students?: number;
}

export interface StudentRow extends TimeFields {
  student_id: string;
  // Display label: first name, else "Student N" (never phone digits).
  label: string;
  // The student's WhatsApp number (users.external_id), shown beside the name
  // on the teacher dashboard so a teacher can tell students apart. In full
  // only for the student's own teacher (PiiAccessService); masked to
  // first…last otherwise, like `label` and `name`.
  phone: string;
  // The full name as stored (null until a parent/teacher sets one) — the
  // class view shows and edits this via PATCH /users/:id/profile.
  name: string | null;
  // Whether label / name / phone above are as stored or masked; the class
  // view only offers the rename control when 'full'.
  pii: PiiVisibility;
  score: number | null;
  passed: boolean | null;
  attempts: number;
  in_band: boolean;
  active: boolean;
  last_active_at: string | null;
  // Score change in points (0–100) against the student's newest row dated
  // ≤ as_of − range days (all time: the oldest row before as_of); null
  // without a prior row or a score.
  delta: number | null;
}

export interface ScoresResponse {
  as_of: string | null;
  metric: LiteracyMetric;
  range: DashboardRange;
  // Echoed when the request carried one (usage only).
  window?: TimeWindow;
  // Test metrics only: the age band the metric counts ([min, max) whole
  // years — age-bands.ts) and the pass mark as a percentage (NIPUN passes
  // AT it, MPL-B strictly above — literacy-test-scores.ts), so the dashboard's
  // "{n}% of 7–8 year old students pass …" and its pass-mark line come from
  // the code that decides them.
  age_band?: [number, number];
  pass_mark?: number;
  entity: GeoRef;
  root: RootStats;
  series: SeriesPoint[];
  child_type: ChildType | null;
  children: ChildRow[] | StudentRow[];
  most_improved: ChildRow[];
  students_series?: StudentSeries[];
  children_series?: ChildSeries[];
  // Time mode: `delta` is the change in minutes against the window before —
  // 1 = yesterday vs the day before, 7 = the last seven days vs the seven
  // before (all time compares the last seven days too).
  time_delta_days?: 1 | 7;
}

export interface SpotlightEntry {
  child: ChildRow;
  official: Official | null;
}

export interface SpotlightResponse {
  top: SpotlightEntry | null;
  most_improved: SpotlightEntry | null;
}

export function validateMetric(raw: unknown): LiteracyMetric {
  if (
    typeof raw !== 'string' ||
    !(DASHBOARD_METRICS as readonly string[]).includes(raw)
  ) {
    throw new BadRequestException(
      `metric must be one of: ${DASHBOARD_METRICS.join(', ')}`,
    );
  }
  return raw as LiteracyMetric;
}

export function validateRange(raw: unknown): DashboardRange {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RANGE;
  if (raw === 'all') return 'all';
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!(DASHBOARD_RANGES as readonly unknown[]).includes(n)) {
    throw new BadRequestException(
      `range must be one of: ${DASHBOARD_RANGES.join(', ')}`,
    );
  }
  return n as DashboardRange;
}

// The age band and pass mark of a test metric; nothing for usage.
export function testMeta(
  metric: LiteracyMetric,
): Pick<ScoresResponse, 'age_band' | 'pass_mark'> {
  if (metric === 'usage') return {};
  return {
    age_band: [...METRIC_AGE_BANDS[metric]],
    pass_mark: Math.round(
      (metric === 'mpl_b' ? MPL_B_PASS_THRESHOLD : NIPUN_PASS_THRESHOLD) * 100,
    ),
  };
}

// Absent → undefined (the legacy usage response); anything else must be a
// known window.
export function validateWindow(raw: unknown): TimeWindow | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (
    typeof raw !== 'string' ||
    !(TIME_WINDOWS as readonly string[]).includes(raw)
  ) {
    throw new BadRequestException(
      `window must be one of: ${TIME_WINDOWS.join(', ')}`,
    );
  }
  return raw as TimeWindow;
}

// GET users/:id/usage-history — a student's active minutes per day. `date`
// is the day the minutes were spent (not the nightly row's date); days
// without activity are 0, so the series is continuous from the student's
// first stored day (or the start of the range) to the last nightly run.
export interface UsageHistoryPoint {
  date: string;
  minutes: number;
}
export interface UsageHistoryResponse {
  as_of: string | null;
  range: DashboardRange;
  points: UsageHistoryPoint[];
}

// ─── Arithmetic (pure; dashboard-scores.spec.ts) ─────────────────────────────

const round1 = (v: number) => Math.round(v * 10) / 10;

// Time figures from a total of minutes spread over `days` days by
// `students` students (1 for a single student).
export function timeFields(
  totalMinutes: number,
  studentDays: number,
  days: number,
): Required<TimeFields> {
  if (studentDays <= 0 || days <= 0) {
    return { time_total: null, time_per_day: null, time_days: days };
  }
  const perDay = totalMinutes / studentDays;
  return {
    time_total: round1(perDay * days),
    time_per_day: round1(perDay),
    time_days: days,
  };
}

const shiftIsoDay = (iso: string, days: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

// A student's daily minutes from their stored rows. A row dated D holds the
// minutes of the day BEFORE D (the nightly summarises the last complete
// day), so each point is labelled D − 1. The series runs from the student's
// first stored row (or the start of the range) to the newest nightly —
// `lastRun` when the student has been quiet since — with 0 on every day
// that has no row or no minutes.
export function buildUsageHistory(
  rows: ReadonlyArray<{ computed_for: string; minutes: number | null }>,
  lastRun: string | null,
  range: DashboardRange,
): UsageHistoryResponse {
  if (rows.length === 0) return { as_of: lastRun, range, points: [] };
  const byDay = new Map(rows.map((r) => [r.computed_for, r.minutes ?? 0]));
  const dates = [...byDay.keys()].sort();
  const first = dates[0];
  const newest = dates[dates.length - 1];
  const asOf = lastRun !== null && lastRun > newest ? lastRun : newest;
  const rangeStart = range === 'all' ? first : shiftIsoDay(asOf, -(range - 1));
  const start = rangeStart > first ? rangeStart : first;
  const points: UsageHistoryPoint[] = [];
  for (let d = start; d <= asOf; d = shiftIsoDay(d, 1)) {
    points.push({
      date: shiftIsoDay(d, -1),
      minutes: round1(byDay.get(d) ?? 0),
    });
  }
  return { as_of: asOf, range, points };
}

// Bin for an average of minutes per day: high above the 5-minute mark, mid
// for any use, low for none.
export function timeBin(
  perDay: number | null | undefined,
  usingLifteracy: boolean,
): Bin {
  if (!usingLifteracy || perDay === null || perDay === undefined) return 'none';
  if (perDay > TIME_PASS_MINUTES_PER_DAY) return 'high';
  return perDay > 0 ? 'mid' : 'low';
}

export function passRate(pass: number, n: number): number | null {
  if (n <= 0) return null;
  return Math.round((pass / n) * 1000) / 10;
}

export function meanOf(sum: number, n: number): number | null {
  if (n <= 0) return null;
  return sum / n;
}

// Population standard deviation from the stored sums; 0 when n ≤ 1.
export function populationSd(
  sum: number,
  sumsq: number,
  n: number,
): number | null {
  if (n <= 0) return null;
  if (n <= 1) return 0;
  const mean = sum / n;
  const variance = Math.max(0, sumsq / n - mean * mean);
  return Math.sqrt(variance);
}

export function delta(
  latest: number | null,
  prior: number | null | undefined,
): number | null {
  if (latest === null || prior === null || prior === undefined) return null;
  return Math.round((latest - prior) * 10) / 10;
}

export function binOf(
  passRateValue: number | null,
  usingLifteracy: boolean,
): Bin {
  if (!usingLifteracy || passRateValue === null) return 'none';
  if (passRateValue >= 80) return 'high';
  if (passRateValue >= 50) return 'mid';
  return 'low';
}

// A child "uses Lifteracy" when it has a row at as_of with anyone scored or
// unbanded — NOT students_active: a school whose students went quiet has
// still used Lifteracy and keeps its last colour; activity is a separate
// number.
export function usingLifteracy(
  row:
    | {
        students_scored: number;
        students_unbanded: number;
      }
    | null
    | undefined,
): boolean {
  return !!row && row.students_scored + row.students_unbanded > 0;
}

// First name if set, else a stable ordinal within the school — never
// anything derived from the phone number.
export function studentLabel(name: string | null, ordinal: number): string {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first ? first : `Student ${ordinal}`;
}

// Scored desc; unscored next by last_active_at desc; neither last.
export function compareStudents(a: StudentRow, b: StudentRow): number {
  if (a.score !== null && b.score !== null) return b.score - a.score;
  if (a.score !== null) return -1;
  if (b.score !== null) return 1;
  const ta = a.last_active_at ? Date.parse(a.last_active_at) : -Infinity;
  const tb = b.last_active_at ? Date.parse(b.last_active_at) : -Infinity;
  if (ta !== tb) return tb - ta;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]);
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s =
      typeof v === 'object' ? JSON.stringify(v) : String(v as string | number);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    columns.join(','),
    ...rows.map((r) => columns.map((c) => cell(r[c])).join(',')),
  ].join('\n');
}
