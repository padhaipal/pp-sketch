import { ageOn, inBand, METRIC_AGE_BANDS } from './age-bands';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('ageOn', () => {
  it('counts whole years, birthday on the 1st of the birth month', () => {
    expect(ageOn(d('2026-09-12'), 2018, 9)).toBe(8); // birthday this month → reached
    expect(ageOn(d('2026-09-01'), 2018, 9)).toBe(8); // birthday today (the 1st)
    expect(ageOn(d('2026-08-31'), 2018, 9)).toBe(7); // the day before
    expect(ageOn(d('2026-12-31'), 2018, 1)).toBe(8);
    expect(ageOn(d('2026-01-01'), 2018, 1)).toBe(8);
  });

  it('assumes July when birth_month is null or out of range', () => {
    expect(ageOn(d('2026-06-30'), 2018, null)).toBe(7);
    expect(ageOn(d('2026-07-01'), 2018, null)).toBe(8);
    expect(ageOn(d('2026-07-01'), 2018, 13)).toBe(8);
    expect(ageOn(d('2026-07-01'), 2018, 0)).toBe(8);
  });

  it('is null (unbanded) without a birth_year', () => {
    expect(ageOn(d('2026-09-12'), null, 7)).toBeNull();
    expect(ageOn(d('2026-09-12'), NaN, 7)).toBeNull();
  });
});

describe('inBand', () => {
  it('uses [min, max) per metric and rejects null ages', () => {
    expect(METRIC_AGE_BANDS.nipun_g2).toEqual([7, 9]);
    expect(inBand('nipun_g2', 7)).toBe(true);
    expect(inBand('nipun_g2', 8)).toBe(true);
    expect(inBand('nipun_g2', 9)).toBe(false);
    expect(inBand('nipun_g3', 7)).toBe(false);
    expect(inBand('nipun_g3', 8)).toBe(true);
    expect(inBand('mpl_b', 9)).toBe(true);
    expect(inBand('mpl_b', 10)).toBe(false);
    expect(inBand('mpl_b', null)).toBe(false);
  });
});
