import {
  aserColumnsForLevel,
  backfillAser,
  type BackfillAserDeps,
} from './backfill-aser';
import {
  aserTestLevel,
  type AserTestKey,
  type AserTestScore,
} from '../literacy/aser/aser';
import type {
  GeoVector,
  StudentAserGradeRow,
} from '../literacy/score/test-results.service';

const NONE: AserTestScore = { status: 'insufficient_data', runs_available: 0 };
// A test with one history point per [run, at, passed].
const test = (
  ...points: Array<[run: number, at: string, passed: boolean]>
): AserTestScore => {
  const history = points.map(([run, at, passed]) => ({
    run,
    at: new Date(at),
    correct: passed ? 1 : 0,
    incorrect: passed ? 0 : 1,
    passed,
  }));
  return {
    status: 'ok',
    runs_available: history.length,
    latest: history[history.length - 1],
    history,
  };
};
const tests = (
  over: Partial<Record<AserTestKey, AserTestScore>>,
): Record<AserTestKey, AserTestScore> => ({
  aser_l1: NONE,
  aser_l2: NONE,
  aser_l3: NONE,
  aser_l4: NONE,
  ...over,
});

// six on these nights (born 2020, onboarded aged 6), eight, and no age
const student = (id: string, birth_year: number | null, geo = 'school') => ({
  id,
  birth_year,
  birth_month: 1,
  created_at: '2026-08-01T00:00:00Z',
  geo_entity_id: geo as string | null,
});

function make(
  students: ReturnType<typeof student>[],
  byId: Record<string, Record<AserTestKey, AserTestScore>>,
) {
  const studentWrites: Array<[string, StudentAserGradeRow[]]> = [];
  const geoWrites: Array<[string, Array<[string, GeoVector]>, Date]> = [];
  const logs: string[] = [];
  const deps: BackfillAserDeps = {
    log: (m) => logs.push(m),
    query: () => Promise.resolve(students),
    aserTests: () => Promise.resolve(new Map(Object.entries(byId))),
    ancestors: () => Promise.resolve([{ id: 'block' }, { id: 'country' }]),
    updateStudentAserGrade: (rows, d) => {
      studentWrites.push([d, rows]);
      return Promise.resolve();
    },
    upsertGeoAserGrade: (entries, d, at) => {
      geoWrites.push([d, entries, at]);
      return Promise.resolve(entries.length);
    },
  };
  return { deps, studentWrites, geoWrites, logs };
}

describe('backfillAser', () => {
  it('aserColumnsForLevel reads back as the same level', () => {
    for (const level of [0, 1, 2, 3, 4]) {
      const c = aserColumnsForLevel(level);
      expect(
        aserTestLevel({
          aser_l1: { correct: c.aser_l1_correct, passed: c.aser_l1_passed },
          aser_l2: { correct: c.aser_l2_correct, passed: c.aser_l2_passed },
          aser_l3: { correct: c.aser_l3_correct, passed: c.aser_l3_passed },
          aser_l4: { correct: c.aser_l4_correct, passed: c.aser_l4_passed },
        }),
      ).toBe(level);
    }
  });

  it('each night: the level from runs finished before 00:15 IST, the age rule on that night, rolled up the tree', async () => {
    // "a" (six): Word on the 10th, Paragraph on the 12th (IST afternoons).
    // "b" (eight): Story on the 10th — listed, never counted.
    // "c" (no age) and "d" (no school): never in an area figure.
    const { deps, studentWrites, geoWrites } = make(
      [
        student('a', 2020),
        student('b', 2018),
        student('c', null),
        student('d', 2020, null as unknown as string),
        student('e', 2020), // never tested
      ],
      {
        a: tests({
          aser_l2: test([1, '2026-09-10T09:00:00Z', true]),
          aser_l3: test([2, '2026-09-12T09:00:00Z', true]),
        }),
        b: tests({ aser_l4: test([1, '2026-09-10T09:00:00Z', true]) }),
        c: tests({ aser_l4: test([1, '2026-09-10T09:00:00Z', true]) }),
        d: tests({ aser_l3: test([1, '2026-09-10T09:00:00Z', true]) }),
      },
    );
    const summary = await backfillAser(deps, {
      to: '2026-09-13',
      dryRun: false,
    });
    // from = the night after the first finished run
    expect(summary).toEqual({
      students: 4,
      days: 3,
      studentRows: 12,
      geoRows: 9,
      from: '2026-09-11',
    });
    expect(geoWrites.map(([d]) => d)).toEqual([
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
    ]);
    // stamped as the nightly would have: 00:15 IST
    expect(geoWrites[0][2].toISOString()).toBe('2026-09-10T18:45:00.000Z');
    const figure = (night: number, id: string) => {
      const v = new Map(geoWrites[night][1]).get(id)!.aser_grade;
      return { n: v.n, pass: v.pass, hist: v.hist };
    };
    // 11th and 12th: "a" is at Word — counted, not passing
    for (const id of ['school', 'block', 'country']) {
      expect(figure(0, id)).toEqual({ n: 1, pass: 0, hist: [0, 0, 1, 0, 0] });
      expect(figure(1, id)).toEqual({ n: 1, pass: 0, hist: [0, 0, 1, 0, 0] });
      // 13th: the Paragraph run of the 12th has landed — a six-year-old passes
      expect(figure(2, id)).toEqual({ n: 1, pass: 1, hist: [0, 0, 0, 1, 0] });
    }
    // only aser_grade is carried
    const v = new Map(geoWrites[2][1]).get('country')!;
    expect(v.usage.n).toBe(0);
    expect(v.students_active + v.students_scored + v.students_unbanded).toBe(0);
    // student rows: every tested student, any age, with their own verdict
    expect(studentWrites[2]).toEqual([
      '2026-09-13',
      [
        { student_id: 'a', score: 0.75, passed: true, attempts: 2 },
        { student_id: 'b', score: 1, passed: true, attempts: 1 },
        { student_id: 'c', score: 1, passed: true, attempts: 1 },
        { student_id: 'd', score: 0.75, passed: true, attempts: 1 },
      ],
    ]);
    expect(studentWrites[0][1][0]).toEqual({
      student_id: 'a',
      score: 0.5,
      passed: false,
      attempts: 1,
    });
  });

  it('dry run writes nothing; no finished runs is a no-op; from after to throws', async () => {
    const one = {
      a: tests({ aser_l2: test([1, '2026-09-10T09:00:00Z', true]) }),
    };
    const dry = make([student('a', 2020)], one);
    const s = await backfillAser(dry.deps, { to: '2026-09-12', dryRun: true });
    expect(s.days).toBe(2);
    expect(dry.geoWrites).toHaveLength(0);
    expect(dry.studentWrites).toHaveLength(0);
    expect(dry.logs[0]).toContain('(dry run)');

    const none = make([student('a', 2020)], {});
    expect(
      (await backfillAser(none.deps, { to: '2026-09-12', dryRun: false })).days,
    ).toBe(0);

    await expect(
      backfillAser(make([student('a', 2020)], one).deps, {
        from: '2026-09-20',
        to: '2026-09-12',
        dryRun: false,
      }),
    ).rejects.toThrow('is after');
  });
});
