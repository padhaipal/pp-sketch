// Age bands per literacy metric, applied by the nightly test-results job
// when aggregating students into geo-entity rows (test-results.service.ts).
// A student outside a metric's band is excluded from THAT metric's n; a
// student with no birth_year at all is "unbanded": excluded from every
// metric's n and counted in students_unbanded.

export type LiteracyMetric = 'nipun_g2' | 'nipun_g3' | 'mpl_b';

// [min, max) in whole years on the computed_for date.
//
// PLACEHOLDER VALUES — confirm with Tom before merging anything that reads
// these for a real decision. The shape is final; the numbers are not.
export const METRIC_AGE_BANDS: Record<LiteracyMetric, [number, number]> = {
  nipun_g2: [7, 9],
  nipun_g3: [8, 10],
  mpl_b: [8, 10],
};

// Whole years between the assumed birth date and `date`. Day of month is
// assumed to be the 1st; a null birth_month assumes July (mid-year, the
// least-biased guess when only the year is known). Null birth_year → null.
// `date` is read as a calendar date in UTC — callers pass the computed_for
// date (an IST calendar date at midnight UTC), never an arbitrary instant.
export function ageOn(
  date: Date,
  birthYear: number | null,
  birthMonth: number | null,
): number | null {
  if (birthYear === null || !Number.isInteger(birthYear)) return null;
  const month =
    birthMonth !== null &&
    Number.isInteger(birthMonth) &&
    birthMonth >= 1 &&
    birthMonth <= 12
      ? birthMonth
      : 7;
  let age = date.getUTCFullYear() - birthYear;
  // Birthday (the 1st of the birth month) not yet reached this year.
  if (date.getUTCMonth() + 1 < month) age -= 1;
  return age;
}

export function inBand(metric: LiteracyMetric, age: number | null): boolean {
  if (age === null) return false;
  const [min, max] = METRIC_AGE_BANDS[metric];
  return age >= min && age < max;
}
