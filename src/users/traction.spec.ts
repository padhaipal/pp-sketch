import * as fs from 'fs';
import * as path from 'path';
import { buildTraction, dateRange, type TractionInputs } from './traction';

const empty = (): TractionInputs => ({
  activityByDay: [],
  activeMonths: [],
  messageDays: [],
  students: [],
  teacherDays: [],
  mplb: [],
  aser: [],
});
const AT = new Date('2026-09-04T00:00:00Z');

describe('dateRange', () => {
  it('is inclusive and empty when to < from', () => {
    expect(dateRange('2026-09-30', '2026-10-02')).toEqual([
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    expect(dateRange('2026-09-02', '2026-09-01')).toEqual([]);
  });
});

describe('buildTraction', () => {
  it('flows per day: users over 5 min and minutes (1 dp); zero on quiet days', () => {
    const out = buildTraction(
      {
        ...empty(),
        activityByDay: [
          { date: '2026-09-01', users_over_5min: 3, active_ms: 1_234_567 },
          { date: '2026-08-31', users_over_5min: 9, active_ms: 9 },
        ],
      },
      '2026-09-01',
      '2026-09-02',
      AT,
    );
    expect(out.from).toBe('2026-09-01');
    expect(out.to).toBe('2026-09-02');
    expect(out.computed_at).toBe(AT.toISOString());
    expect(out.daily.map((d) => [d.users_over_5min, d.minutes])).toEqual([
      [3, 20.6],
      [0, 0],
    ]);
  });

  it('stocks: students and teachers cumulative from before the window', () => {
    const out = buildTraction(
      {
        ...empty(),
        students: [
          { id: 'a', onboarded_on: '2026-08-10', units: [] },
          { id: 'b', onboarded_on: '2026-09-02', units: [] },
        ],
        teacherDays: ['2026-09-01', '2026-07-01', '2026-09-03'],
      },
      '2026-09-01',
      '2026-09-03',
      AT,
    );
    expect(out.daily.map((d) => d.students_onboarded)).toEqual([1, 2, 2]);
    expect(out.daily.map((d) => d.teachers_onboarded)).toEqual([2, 2, 3]);
  });

  it('units count from their first onboarded student, at every level', () => {
    const chain = (school: string) => [
      { id: school, type: 'school' },
      { id: 'blk', type: 'block' },
      { id: 'dst', type: 'district' },
      { id: 'up', type: 'state' },
      { id: 'in', type: 'country' },
    ];
    const out = buildTraction(
      {
        ...empty(),
        students: [
          { id: 'a', onboarded_on: '2026-09-02', units: chain('s1') },
          { id: 'b', onboarded_on: '2026-09-01', units: chain('s1') },
          { id: 'c', onboarded_on: '2026-09-03', units: chain('s2') },
          // referred by a block official: no school, still the block's
          { id: 'd', onboarded_on: '2026-09-03', units: chain('x').slice(1) },
        ],
      },
      '2026-09-01',
      '2026-09-03',
      AT,
    );
    expect(
      out.daily.map((d) => [d.schools, d.blocks, d.districts, d.states]),
    ).toEqual([
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [2, 1, 1, 1],
    ]);
  });

  it('MPL-B: each student’s latest nightly result; day X reads rows dated <= X + 1', () => {
    const out = buildTraction(
      {
        ...empty(),
        mplb: [
          { student_id: 'a', computed_for: '2026-09-02', passed: true },
          { student_id: 'b', computed_for: '2026-09-03', passed: true },
          { student_id: 'a', computed_for: '2026-09-04', passed: false },
          { student_id: 'c', computed_for: '2026-09-04', passed: null },
        ],
      },
      '2026-09-01',
      '2026-09-03',
      AT,
    );
    expect(out.daily.map((d) => d.mpl_b_passed)).toEqual([1, 2, 1]);
  });

  it('ASER: the country figure of the latest night dated <= X + 1, carried forward; 0 before the first', () => {
    const out = buildTraction(
      {
        ...empty(),
        aser: [
          { computed_for: '2026-09-05', passing: 9 },
          { computed_for: '2026-09-03', passing: 4 },
        ],
      },
      '2026-09-01',
      '2026-09-05',
      AT,
    );
    expect(out.daily.map((d) => d.aser_passed)).toEqual([0, 4, 4, 9, 9]);
  });

  it('monthly: active students split by onboarding month; the month in progress projected linearly', () => {
    const out = buildTraction(
      {
        ...empty(),
        students: [
          { id: 'a', onboarded_on: '2026-08-20', units: [] },
          { id: 'b', onboarded_on: '2026-09-02', units: [] },
          { id: 'c', onboarded_on: '2026-09-03', units: [] },
        ],
        activeMonths: [
          { user_id: 'a', month: '2026-08' },
          { user_id: 'a', month: '2026-09' },
          { user_id: 'b', month: '2026-09' },
          { user_id: 'c', month: '2026-08' }, // active before onboarding
          { user_id: 'x', month: '2026-09' }, // not onboarded: ignored
        ],
      },
      '2026-08-01',
      '2026-09-10',
      AT,
    );
    expect(out.monthly).toEqual([
      {
        month: '2026-08',
        joined_earlier: 0,
        joined_this_month: 2,
        projected_joined_earlier: null,
        projected_joined_this_month: null,
        mau: 0,
        dau_avg: 0,
        dau_mau: null,
        projected_dau_mau: null,
      },
      {
        month: '2026-09',
        joined_earlier: 1,
        joined_this_month: 1,
        projected_joined_earlier: 3, // 1 × 30 ÷ 10
        projected_joined_this_month: 3,
        mau: 0,
        dau_avg: 0,
        dau_mau: null,
        projected_dau_mau: null,
      },
    ]);
  });

  it('monthly DAU / MAU: onboarded students who wrote that month, averaged over every day of it', () => {
    const out = buildTraction(
      {
        ...empty(),
        students: [
          { id: 'a', onboarded_on: '2026-08-20', units: [] },
          { id: 'b', onboarded_on: '2026-09-02', units: [] },
        ],
        messageDays: [
          // August (31 days): a writes on 3 days → MAU 1, DAU 3/31
          { user_id: 'a', date: '2026-08-20' },
          { user_id: 'a', date: '2026-08-21' },
          { user_id: 'a', date: '2026-08-21' }, // repeated row: one day
          { user_id: 'a', date: '2026-08-30' },
          { user_id: 'b', date: '2026-08-30' }, // onboarded in September: ignored
          { user_id: 'x', date: '2026-08-30' }, // never onboarded: ignored
          // September, 10 complete days: a on 4 days, b on 2 → MAU 2, DAU 0.6
          { user_id: 'a', date: '2026-09-01' },
          { user_id: 'a', date: '2026-09-02' },
          { user_id: 'a', date: '2026-09-03' },
          { user_id: 'a', date: '2026-09-04' },
          { user_id: 'b', date: '2026-09-02' },
          { user_id: 'b', date: '2026-09-09' },
          { user_id: 'a', date: '2026-09-11' }, // after `to`: ignored
        ],
      },
      '2026-08-01',
      '2026-09-10',
      AT,
    );
    expect(out.monthly[0]).toEqual(
      expect.objectContaining({
        month: '2026-08',
        mau: 1,
        dau_avg: 0.1, // 3 ÷ 31
        dau_mau: 9.7,
        projected_dau_mau: null,
      }),
    );
    expect(out.monthly[1]).toEqual(
      expect.objectContaining({
        month: '2026-09',
        mau: 2,
        dau_avg: 0.6, // 6 student-days ÷ 10 complete days
        dau_mau: 30,
        // August had no writer in its first 10 days: nothing to scale by
        projected_dau_mau: null,
      }),
    );
  });

  it('monthly DAU / MAU: the month in progress is estimated from how last month settled', () => {
    const day = (user_id: string, date: string) => ({ user_id, date });
    const out = buildTraction(
      {
        ...empty(),
        students: ['a', 'b', 'c', 'd'].map((id) => ({
          id,
          onboarded_on: '2026-07-01',
          units: [],
        })),
        messageDays: [
          // August, first 10 days: a ×5, b ×5 → 10 ÷ 10 ÷ 2 = 50 %
          ...[1, 2, 3, 4, 5].map((d) => day('a', `2026-08-0${d}`)),
          ...[1, 2, 3, 4, 5].map((d) => day('b', `2026-08-0${d}`)),
          // … then c and d write once each: 12 ÷ 31 ÷ 4 = 9.68 % for the month
          day('c', '2026-08-20'),
          day('d', '2026-08-25'),
          // September so far (10 days): a ×4 → 4 ÷ 10 ÷ 1 = 40 %
          ...[1, 2, 3, 4].map((d) => day('a', `2026-09-0${d}`)),
        ],
      },
      '2026-08-01',
      '2026-09-10',
      AT,
    );
    expect(out.monthly[0]).toEqual(
      expect.objectContaining({
        mau: 4,
        dau_mau: 9.7,
        projected_dau_mau: null,
      }),
    );
    expect(out.monthly[1]).toEqual(
      expect.objectContaining({
        mau: 1,
        dau_mau: 40,
        projected_dau_mau: 7.7, // 40 % × (9.68 ÷ 50)
      }),
    );
  });

  it('totals: all-time hours and onboarded students through `to`, before the window too', () => {
    const out = buildTraction(
      {
        ...empty(),
        activityByDay: [
          { date: '2026-03-10', users_over_5min: 1, active_ms: 3_600_000 },
          { date: '2026-09-02', users_over_5min: 1, active_ms: 5_400_000 },
          { date: '2026-09-04', users_over_5min: 1, active_ms: 9_000_000 }, // after `to`
        ],
        students: [
          { id: 'a', onboarded_on: '2026-03-01', units: [] },
          { id: 'b', onboarded_on: '2026-09-02', units: [] },
          { id: 'c', onboarded_on: '2026-09-04', units: [] }, // after `to`
        ],
      },
      '2026-09-01',
      '2026-09-03',
      AT,
    );
    expect(out.totals).toEqual({ hours: 3, students: 2 }); // 2.5 h rounds up
  });

  it('monthly: a month ending on `to` is complete (no projection)', () => {
    const out = buildTraction(empty(), '2026-09-01', '2026-09-30', AT);
    expect(out.monthly).toEqual([
      {
        month: '2026-09',
        joined_earlier: 0,
        joined_this_month: 0,
        projected_joined_earlier: null,
        projected_joined_this_month: null,
        mau: 0,
        dau_avg: 0,
        dau_mau: null,
        projected_dau_mau: null,
      },
    ]);
  });
});

// main.ts is coverage-ignored; pin that the warm worker is registered.
describe('traction-warm worker registration', () => {
  const SRC = path.join(__dirname, '..');
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

  it('main.ts schedules the cron and creates the worker', () => {
    const main = read('main.ts');
    expect(main).toMatch(/createQueue\(QUEUE_NAMES\.TRACTION_WARM\)/);
    expect(main).toMatch(
      /'traction-warm-cron',\s*\{\},\s*\{ repeat: \{ pattern: TRACTION_WARM_CRON \} \}/,
    );
    expect(main).toMatch(
      /createWorker\(\s*QUEUE_NAMES\.TRACTION_WARM,[\s\S]*?processTractionWarmJob\(job, tractionService\)/,
    );
  });

  it('the service is provided by UserModule and the route exists', () => {
    expect(read('users/user.module.ts')).toMatch(/TractionService,/);
    expect(read('users/user.controller.ts')).toMatch(
      /@Get\('dashboard\/traction'\)/,
    );
  });
});
