import { BadRequestException } from '@nestjs/common';
import type { LiteracyMetric } from './age-bands';
import type { GeoEntityType } from '../../geo-entities/geo-entity.dto';

export const DASHBOARD_METRICS: readonly LiteracyMetric[] = [
  'nipun_g2',
  'nipun_g3',
  'mpl_b',
];
export const DASHBOARD_RANGES = [30, 90] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];
export const DEFAULT_RANGE: DashboardRange = 30;
export const MOST_IMPROVED_MIN_N = 5;
export const MOST_IMPROVED_LIMIT = 5;
export const ACTIVE_WINDOW_DAYS = 14;
// Public responses are cached: the data changes once a night and these are
// the heaviest unauthenticated queries in the app.
export const PUBLIC_CACHE_CONTROL = 'public, max-age=300';

export type ChildType = 'state' | 'district' | 'block' | 'school' | 'student';

// The child level below each root type; a school's children are students.
export const CHILD_TYPE_OF: Record<GeoEntityType, ChildType | null> = {
  country: 'state',
  state: 'district',
  district: 'block',
  block: 'school',
  school: 'student',
  cluster: null,
};

export interface GeoRef {
  id: string;
  type: GeoEntityType;
  code: string;
  name: string;
  has_boundary: boolean;
  lat: number | null;
  lng: number | null;
}

export interface RootStats {
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
}

export type Bin = 'high' | 'mid' | 'low' | 'none';

export interface Official {
  name: string | null;
  role_title: string | null;
  avatar_seed: string | null;
  spotlight_message: string | null;
}

export interface ChildRow extends GeoRef {
  pass_rate: number | null;
  n: number;
  students_active: number;
  using_lifteracy: boolean;
  delta: number | null;
  bin: Bin;
  official: Official | null;
}

export interface StudentRow {
  student_id: string;
  label: string;
  score: number | null;
  passed: boolean | null;
  attempts: number;
  in_band: boolean;
  active: boolean;
  last_active_at: string | null;
}

export interface ScoresResponse {
  as_of: string | null;
  metric: LiteracyMetric;
  range: DashboardRange;
  entity: GeoRef;
  root: RootStats;
  series: SeriesPoint[];
  child_type: ChildType | null;
  children: ChildRow[] | StudentRow[];
  most_improved: ChildRow[];
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
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!(DASHBOARD_RANGES as readonly number[]).includes(n)) {
    throw new BadRequestException(
      `range must be one of: ${DASHBOARD_RANGES.join(', ')}`,
    );
  }
  return n as DashboardRange;
}

// ─── Arithmetic (pure; dashboard-scores.spec.ts) ─────────────────────────────

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
