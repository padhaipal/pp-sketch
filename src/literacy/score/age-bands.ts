// Age bands per literacy metric, applied by the nightly test-results job
// when aggregating students into geo-entity rows (test-results.service.ts).
// A student outside a metric's band is excluded from THAT metric's n; a
// student with no birth_year at all is "unbanded": excluded from every
// metric's n and counted in students_unbanded.

// The three literacy-test proxies plus `usage` — the leading indicator:
// active minutes per day (test-results.service.ts), no age band.
export type LiteracyMetric = 'nipun_g2' | 'nipun_g3' | 'mpl_b' | 'usage';
export type TestMetric = Exclude<LiteracyMetric, 'usage'>;

// [min, max) in whole years on the computed_for date — confirmed with Tom
// 2026-10: a test's window runs from the child's min-th birthday to the day
// before their max-th. The bands are disjoint; nine-year-olds sit no test.
export const METRIC_AGE_BANDS: Record<TestMetric, [number, number]> = {
  nipun_g2: [7, 8],
  nipun_g3: [8, 9],
  mpl_b: [10, 11],
};

export const IST_OFFSET_MS = 5.5 * 3_600_000;
// Months since year 0 of the IST calendar month holding `at`.
function istAbsoluteMonth(at: Date): number {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return ist.getUTCFullYear() * 12 + ist.getUTCMonth();
}

// The birth (year, month) the age rule works from. Day of month is always
// the 1st. With a birth_month, that month. Without one, onboarding only
// recorded a stated age (birth_year = IST year of onboarding − age,
// onboarding.service.ts), so the child is taken to be that age and a half
// on the day they were onboarded (`createdAt`): born age×12 + 6 months
// before it. A child who said "7" in March 2026 is read as born September
// 2018 and turns 8 in September 2026. Without createdAt (legacy callers)
// July of birth_year.
export function assumedBirth(
  birthYear: number,
  birthMonth: number | null,
  createdAt?: Date | string | null,
): [year: number, month: number] {
  if (
    birthMonth !== null &&
    Number.isInteger(birthMonth) &&
    birthMonth >= 1 &&
    birthMonth <= 12
  ) {
    return [birthYear, birthMonth];
  }
  if (createdAt) {
    const onboarded = istAbsoluteMonth(new Date(createdAt));
    const statedAge = Math.floor(onboarded / 12) - birthYear;
    if (statedAge >= 0) {
      const born = onboarded - (statedAge * 12 + 6);
      return [Math.floor(born / 12), (born % 12) + 1];
    }
  }
  return [birthYear, 7];
}

// Whole years between the assumed birth date (assumedBirth) and `date`.
// Null birth_year → null. `date` is read as a calendar date in UTC —
// callers pass the computed_for date (an IST calendar date at midnight
// UTC), never an arbitrary instant.
export function ageOn(
  date: Date,
  birthYear: number | null,
  birthMonth: number | null,
  createdAt?: Date | string | null,
): number | null {
  if (birthYear === null || !Number.isInteger(birthYear)) return null;
  const [year, month] = assumedBirth(birthYear, birthMonth, createdAt);
  let age = date.getUTCFullYear() - year;
  // Birthday (the 1st of the birth month) not yet reached this year.
  if (date.getUTCMonth() + 1 < month) age -= 1;
  return age;
}

export function inBand(metric: LiteracyMetric, age: number | null): boolean {
  if (metric === 'usage') return true;
  if (age === null) return false;
  const [min, max] = METRIC_AGE_BANDS[metric];
  return age >= min && age < max;
}
