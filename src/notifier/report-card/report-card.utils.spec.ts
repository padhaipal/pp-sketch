// IST = UTC+5:30 (no DST). These helpers anchor daily windows to IST so the
// morning-update cron + the report-card grids align with a learner's local
// calendar, regardless of the worker's host timezone.

import {
  addDays,
  istDateIso,
  istMidnightUtc,
  istWeekday,
} from './report-card.utils';

describe('istMidnightUtc', () => {
  it('IST midnight UTC for an instant at IST noon is 06:30Z of that IST date', () => {
    // 2026-04-27 11:30 IST = 2026-04-27 06:00Z → IST midnight = 2026-04-26 18:30Z.
    const noonIst = new Date('2026-04-27T06:00:00Z');
    expect(istMidnightUtc(noonIst).toISOString()).toBe(
      '2026-04-26T18:30:00.000Z',
    );
  });

  it('an instant just before IST midnight (23:59 IST) maps to TODAY\'s IST midnight (= yesterday 18:30Z)', () => {
    // 2026-04-27 23:59 IST = 2026-04-27 18:29Z → IST midnight of 2026-04-27.
    const lateIst = new Date('2026-04-27T18:29:00Z');
    expect(istMidnightUtc(lateIst).toISOString()).toBe(
      '2026-04-26T18:30:00.000Z',
    );
  });

  it('an instant at IST 00:01 maps to today\'s IST midnight (= yesterday 18:30Z)', () => {
    // 2026-04-28 00:01 IST = 2026-04-27 18:31Z.
    const earlyIst = new Date('2026-04-27T18:31:00Z');
    expect(istMidnightUtc(earlyIst).toISOString()).toBe(
      '2026-04-27T18:30:00.000Z',
    );
  });

  it('defaults to "now" when no argument is passed', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T10:00:00Z'));
    // 2026-05-15 15:30 IST → IST midnight = 2026-05-14T18:30Z.
    expect(istMidnightUtc().toISOString()).toBe('2026-05-14T18:30:00.000Z');
    jest.useRealTimers();
  });
});

describe('addDays', () => {
  it('adds positive days exactly 24*60*60*1000 ms each', () => {
    const start = new Date('2026-04-27T18:30:00Z');
    expect(addDays(start, 1).toISOString()).toBe('2026-04-28T18:30:00.000Z');
    expect(addDays(start, 7).toISOString()).toBe('2026-05-04T18:30:00.000Z');
  });

  it('subtracts when given a negative count', () => {
    const start = new Date('2026-04-27T18:30:00Z');
    expect(addDays(start, -1).toISOString()).toBe('2026-04-26T18:30:00.000Z');
    expect(addDays(start, -7).toISOString()).toBe('2026-04-20T18:30:00.000Z');
  });

  it('0 is a no-op', () => {
    const start = new Date('2026-04-27T18:30:00Z');
    expect(addDays(start, 0).getTime()).toBe(start.getTime());
  });
});

describe('istWeekday', () => {
  // 2026-04-27 is a Monday (IST). 0=Sun..6=Sat.
  it.each<[string, number, string]>([
    // Each ISO instant is mid-IST-day to avoid the UTC→IST flip near 00:00.
    ['2026-04-26T07:00:00Z', 0, 'Sun (2026-04-26 IST)'],
    ['2026-04-27T07:00:00Z', 1, 'Mon (2026-04-27 IST)'],
    ['2026-04-28T07:00:00Z', 2, 'Tue (2026-04-28 IST)'],
    ['2026-04-29T07:00:00Z', 3, 'Wed (2026-04-29 IST)'],
    ['2026-04-30T07:00:00Z', 4, 'Thu (2026-04-30 IST)'],
    ['2026-05-01T07:00:00Z', 5, 'Fri (2026-05-01 IST)'],
    ['2026-05-02T07:00:00Z', 6, 'Sat (2026-05-02 IST)'],
  ])('%s → %i (%s)', (iso, expected) => {
    expect(istWeekday(new Date(iso))).toBe(expected);
  });

  it('an instant just before IST midnight still reports the OUTGOING IST day', () => {
    // 2026-04-27 23:59 IST = Mon = 1.
    expect(istWeekday(new Date('2026-04-27T18:29:00Z'))).toBe(1);
  });

  it('an instant just after IST midnight reports the INCOMING IST day', () => {
    // 2026-04-28 00:01 IST = Tue = 2.
    expect(istWeekday(new Date('2026-04-27T18:31:00Z'))).toBe(2);
  });
});

describe('istDateIso', () => {
  it('formats as YYYY-MM-DD with zero-padded month + day (kills the padStart pad char)', () => {
    // 2026-01-05 12:00 IST = 2026-01-05 06:30Z.
    expect(istDateIso(new Date('2026-01-05T06:30:00Z'))).toBe('2026-01-05');
    // Two-digit month/day in IST.
    expect(istDateIso(new Date('2026-12-31T06:30:00Z'))).toBe('2026-12-31');
  });

  it('returns the IST date, not the UTC date, around midnight', () => {
    // 2026-04-27 23:59 IST = 2026-04-27 18:29Z → IST date = 2026-04-27.
    expect(istDateIso(new Date('2026-04-27T18:29:00Z'))).toBe('2026-04-27');
    // 2026-04-28 00:01 IST = 2026-04-27 18:31Z → IST date = 2026-04-28.
    expect(istDateIso(new Date('2026-04-27T18:31:00Z'))).toBe('2026-04-28');
  });
});
