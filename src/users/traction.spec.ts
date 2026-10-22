import * as fs from 'fs';
import * as path from 'path';
import { buildTraction, dateRange, type TractionInputs } from './traction';

const empty = (): TractionInputs => ({
  activityByDay: [],
  activeMonths: [],
  students: [],
  teacherDays: [],
  mplb: [],
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
      },
      {
        month: '2026-09',
        joined_earlier: 1,
        joined_this_month: 1,
        projected_joined_earlier: 3, // 1 × 30 ÷ 10
        projected_joined_this_month: 3,
      },
    ]);
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
