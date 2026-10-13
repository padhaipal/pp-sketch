import { ageOn, assumedBirth, inBand, METRIC_AGE_BANDS } from './age-bands';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
// An instant on an IST calendar day (09:00 IST).
const ist = (iso: string) => new Date(`${iso}T03:30:00Z`);

describe('ageOn', () => {
  it('counts whole years, birthday on the 1st of the birth month', () => {
    expect(ageOn(d('2026-09-12'), 2018, 9)).toBe(8); // birthday this month → reached
    expect(ageOn(d('2026-09-01'), 2018, 9)).toBe(8); // birthday today (the 1st)
    expect(ageOn(d('2026-08-31'), 2018, 9)).toBe(7); // the day before
    expect(ageOn(d('2026-12-31'), 2018, 1)).toBe(8);
    expect(ageOn(d('2026-01-01'), 2018, 1)).toBe(8);
  });

  it('a known birth month wins over the onboarding estimate', () => {
    expect(ageOn(d('2026-09-12'), 2018, 9, ist('2026-03-15'))).toBe(8);
    expect(ageOn(d('2026-08-31'), 2018, 9, ist('2026-03-15'))).toBe(7);
  });

  it('assumes July when birth_month is null or out of range and no created_at is given', () => {
    expect(ageOn(d('2026-06-30'), 2018, null)).toBe(7);
    expect(ageOn(d('2026-07-01'), 2018, null)).toBe(8);
    expect(ageOn(d('2026-07-01'), 2018, 13)).toBe(8);
    expect(ageOn(d('2026-07-01'), 2018, 0)).toBe(8);
    expect(ageOn(d('2026-07-01'), 2018, null, null)).toBe(8);
  });

  it('is null (unbanded) without a birth_year', () => {
    expect(ageOn(d('2026-09-12'), null, 7)).toBeNull();
    expect(ageOn(d('2026-09-12'), NaN, 7)).toBeNull();
    expect(ageOn(d('2026-09-12'), null, null, ist('2026-03-15'))).toBeNull();
  });
});

describe('assumedBirth — a missing birth month is estimated from onboarding', () => {
  // Onboarding stores birth_year = IST year of onboarding − stated age; the
  // child is taken to be that age and a half that day.
  it('said "7" in March 2026 (birth_year 2019): born September 2018, turns 8 in September 2026', () => {
    expect(assumedBirth(2019, null, ist('2026-03-15'))).toEqual([2018, 9]);
    expect(ageOn(d('2026-03-15'), 2019, null, ist('2026-03-15'))).toBe(7); // as stated
    expect(ageOn(d('2026-08-31'), 2019, null, ist('2026-03-15'))).toBe(7);
    expect(ageOn(d('2026-09-01'), 2019, null, ist('2026-03-15'))).toBe(8);
  });

  it('said "7" in October 2026 (birth_year 2019): born April 2019, turns 8 in April 2027', () => {
    expect(assumedBirth(2019, null, ist('2026-10-12'))).toEqual([2019, 4]);
    expect(ageOn(d('2026-10-12'), 2019, null, ist('2026-10-12'))).toBe(7);
    expect(ageOn(d('2027-03-31'), 2019, null, ist('2026-10-12'))).toBe(7);
    expect(ageOn(d('2027-04-01'), 2019, null, ist('2026-10-12'))).toBe(8);
  });

  it('said "6" in January 2026 (birth_year 2020): born July 2019 — the stated age holds on the onboarding day, not one less', () => {
    expect(assumedBirth(2020, null, ist('2026-01-05'))).toEqual([2019, 7]);
    expect(ageOn(d('2026-01-05'), 2020, null, ist('2026-01-05'))).toBe(6);
    // The old July-of-birth_year rule read this child as 5 until July.
    expect(ageOn(d('2026-01-05'), 2020, null)).toBe(5);
  });

  it('reads the onboarding month in IST and accepts a string created_at', () => {
    // 2026-03-31 22:00 UTC is 2026-04-01 03:30 IST → April.
    expect(assumedBirth(2019, null, new Date('2026-03-31T22:00:00Z'))).toEqual([
      2018, 10,
    ]);
    expect(assumedBirth(2019, null, '2026-03-15T03:30:00Z')).toEqual([2018, 9]);
  });

  it('falls back to July when the birth year is after the onboarding year (edited later)', () => {
    expect(assumedBirth(2027, null, ist('2026-03-15'))).toEqual([2027, 7]);
  });
});

describe('inBand', () => {
  it('uses the disjoint single-year bands [min, max) per metric and rejects null ages', () => {
    expect(METRIC_AGE_BANDS).toEqual({
      nipun_g1: [6, 7],
      nipun_g2: [7, 8],
      nipun_g3: [8, 9],
      mpl_b: [10, 11],
    });
    expect(inBand('nipun_g1', 5)).toBe(false);
    expect(inBand('nipun_g1', 6)).toBe(true);
    expect(inBand('nipun_g1', 7)).toBe(false);
    expect(inBand('nipun_g2', 6)).toBe(false);
    expect(inBand('nipun_g2', 7)).toBe(true);
    expect(inBand('nipun_g2', 8)).toBe(false);
    expect(inBand('nipun_g3', 7)).toBe(false);
    expect(inBand('nipun_g3', 8)).toBe(true);
    expect(inBand('nipun_g3', 9)).toBe(false);
    // Nine-year-olds sit no test.
    expect(inBand('mpl_b', 9)).toBe(false);
    expect(inBand('mpl_b', 10)).toBe(true);
    expect(inBand('mpl_b', 11)).toBe(false);
    expect(inBand('mpl_b', null)).toBe(false);
    // Usage has no band: every student counts, even without a birth year.
    expect(inBand('usage', 3)).toBe(true);
    expect(inBand('usage', null)).toBe(true);
  });
});
