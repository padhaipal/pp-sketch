// test-results.service pulls in the BullMQ queue factory; never open Redis
// from a unit test.
jest.mock('../interfaces/redis/queues', () => ({
  QUEUE_NAMES: { TEST_RESULTS: 'test-results' },
  createQueue: jest.fn(),
}));

import {
  addDays,
  backfillUsage,
  BackfillUsageDeps,
  nightlyInstant,
} from './backfill-usage';
import {
  GeoVector,
  StudentUsageRow,
} from '../literacy/score/test-results.service';

// IST wall-clock → instant.
function ist(iso: string): Date {
  return new Date(`${iso}+05:30`);
}

interface Fixture {
  students: Array<{
    id: string;
    birth_year: number | null;
    birth_month: number | null;
    created_at: Date;
    geo_entity_id: string | null;
  }>;
  notes: Array<{ user_id: string; created_at: Date }>;
  lessons: Array<{ user_id: string; created_at: Date }>;
  ancestors: Record<string, string[]>;
}

function makeDeps(f: Fixture) {
  const studentWrites: Array<[StudentUsageRow[], string, Date]> = [];
  const geoWrites: Array<[Array<[string, GeoVector]>, string, Date]> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('backfill-usage:students')) return f.students;
    if (sql.includes('backfill-usage:voice-notes')) {
      const [ids, start, end] = params as [string[], Date, Date];
      return f.notes.filter(
        (n) =>
          ids.includes(n.user_id) &&
          n.created_at >= start &&
          n.created_at < end,
      );
    }
    if (sql.includes('backfill-usage:lessons')) {
      const [ids, end] = params as [string[], Date];
      return f.lessons.filter(
        (l) => ids.includes(l.user_id) && l.created_at < end,
      );
    }
    throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
  });
  const deps: BackfillUsageDeps = {
    log: jest.fn(),
    query,
    ancestors: jest.fn(async (id: string) =>
      (f.ancestors[id] ?? []).map((a) => ({ id: a })),
    ),
    upsertStudentUsage: jest.fn(async (rows, d, at) => {
      studentWrites.push([rows, d, at]);
      return rows.length;
    }),
    upsertGeoUsage: jest.fn(async (entries, d, at) => {
      geoWrites.push([entries, d, at]);
      return entries.length;
    }),
  };
  return { deps, query, studentWrites, geoWrites };
}

// A: referred, school S1 (block B1 → district D1). Notes on 1 June IST at
// 10:00, 10:01, 10:05 → gaps 60 s (counts) and 240 s (break) = 1.0 min, 3
// notes; plus one at 23:59 IST on 1 June and one at 00:01 IST on 2 June,
// which must land in different days.
// C: referred, same school, joined 3 June → in no geo row before that.
// N: referred but the referrer has no school → student row only.
const FIXTURE: Fixture = {
  students: [
    {
      id: 'A',
      birth_year: 2018,
      birth_month: 7,
      created_at: ist('2026-05-01T09:00:00'),
      geo_entity_id: 'S1',
    },
    {
      id: 'C',
      birth_year: null,
      birth_month: null,
      created_at: ist('2026-06-03T09:00:00'),
      geo_entity_id: 'S1',
    },
    {
      id: 'N',
      birth_year: 2018,
      birth_month: 7,
      created_at: ist('2026-05-01T09:00:00'),
      geo_entity_id: null,
    },
  ],
  notes: [
    { user_id: 'A', created_at: ist('2026-06-01T10:00:00') },
    { user_id: 'A', created_at: ist('2026-06-01T10:01:00') },
    { user_id: 'A', created_at: ist('2026-06-01T10:05:00') },
    { user_id: 'A', created_at: ist('2026-06-01T23:59:00') },
    { user_id: 'A', created_at: ist('2026-06-02T00:01:00') },
    { user_id: 'N', created_at: ist('2026-06-01T12:00:00') },
    { user_id: 'C', created_at: ist('2026-06-03T12:00:00') },
  ],
  lessons: [
    { user_id: 'A', created_at: ist('2026-05-25T10:00:00') },
    { user_id: 'A', created_at: ist('2026-06-09T10:00:00') }, // after the range — must not count
  ],
  ancestors: { S1: ['D1', 'B1'] },
};

describe('backfill-usage helpers', () => {
  it('addDays and nightlyInstant (00:15 IST of computed_for)', () => {
    expect(addDays('2026-06-01', 1)).toBe('2026-06-02');
    expect(addDays('2026-06-01', -1)).toBe('2026-05-31');
    expect(nightlyInstant('2026-06-02').toISOString()).toBe(
      '2026-06-01T18:45:00.000Z',
    );
  });
});

describe('backfillUsage', () => {
  it('writes one student row per (student, day with notes) and geo rows for every day, backdated', async () => {
    const { deps, studentWrites, geoWrites, query } = makeDeps(FIXTURE);
    const summary = await backfillUsage(deps, {
      from: '2026-06-02',
      to: '2026-06-04',
      dryRun: false,
    });

    expect(summary).toEqual({
      students: 3,
      days: 3,
      studentRows: 4, // A×2 (1 & 2 June), N (1 June), C (3 June)
      geoRows: 9, // S1 + B1 + D1, every day
    });
    // Notes read once for the whole range: from the day before `from` to the
    // nightly instant of `to`.
    const notesCall = query.mock.calls.find(([sql]) =>
      sql.includes('voice-notes'),
    )!;
    expect(notesCall[1]).toEqual([
      ['A', 'C', 'N'],
      nightlyInstant('2026-06-01'),
      nightlyInstant('2026-06-04'),
    ]);

    // Row dated 2 June = IST day 1 June.
    const [rows2, d2, at2] = studentWrites[0];
    expect(d2).toBe('2026-06-02');
    expect(at2.toISOString()).toBe('2026-06-01T18:45:00.000Z');
    expect(rows2).toEqual([
      { student_id: 'A', geo_entity_id: 'S1', minutes: 1, notes: 4 },
      { student_id: 'N', geo_entity_id: null, minutes: 0, notes: 1 },
    ]);
    // Row dated 3 June = IST day 2 June: A's 00:01 note alone.
    const [rows3] = studentWrites[1];
    expect(rows3).toEqual([
      { student_id: 'A', geo_entity_id: 'S1', minutes: 0, notes: 1 },
    ]);
    // Row dated 4 June = IST day 3 June: C's first note (C exists by then).
    const [rows4] = studentWrites[2];
    expect(rows4).toEqual([
      { student_id: 'C', geo_entity_id: 'S1', minutes: 0, notes: 1 },
    ]);

    // Geo, 2 June: only A existed (C joins 3 June, N has no school). Usage
    // n=1 with 1.0 minute, active (lesson 25 May inside 14 days), NIPUN
    // vectors empty, not unbanded.
    const [geo2, gd2, gat2] = geoWrites[0];
    expect(gd2).toBe('2026-06-02');
    expect(gat2).toEqual(at2);
    const s1 = new Map(geo2).get('S1')!;
    expect(s1.usage).toMatchObject({ n: 1, sum: 1, sumsq: 1, pass: 0 });
    expect(s1.usage.hist[1]).toBe(1);
    expect(s1.students_active).toBe(1);
    expect(s1.students_scored).toBe(0);
    expect(s1.students_unbanded).toBe(0);
    expect(s1.nipun_g2.n).toBe(0);
    expect(new Map(geo2).get('D1')).toEqual(s1);
    expect(new Map(geo2).get('B1')).toEqual(s1);

    // Geo, 4 June: A (0 minutes, absent) + C (unbanded, 0 minutes).
    const [geo4] = geoWrites[2];
    const s1d4 = new Map(geo4).get('S1')!;
    expect(s1d4.usage).toMatchObject({ n: 2, sum: 0, pass: 0 });
    expect(s1d4.usage.hist[0]).toBe(2);
    expect(s1d4.students_unbanded).toBe(1);
    // The 9 June lesson is after every instant in range → never active via it;
    // 25 May is 10 days before 4 June → still active.
    expect(s1d4.students_active).toBe(1);
    // ancestors() resolved once per school.
    expect(deps.ancestors).toHaveBeenCalledTimes(1);
  });

  it('dry run reads everything and writes nothing', async () => {
    const { deps, studentWrites, geoWrites } = makeDeps(FIXTURE);
    const summary = await backfillUsage(deps, {
      from: '2026-06-02',
      to: '2026-06-02',
      dryRun: true,
    });
    expect(summary.studentRows).toBe(2);
    expect(summary.geoRows).toBe(3);
    expect(studentWrites).toHaveLength(0);
    expect(geoWrites).toHaveLength(0);
  });

  it('no referred students → nothing read beyond the population', async () => {
    const { deps, query } = makeDeps({ ...FIXTURE, students: [] });
    const summary = await backfillUsage(deps, {
      from: '2026-06-02',
      to: '2026-06-02',
      dryRun: false,
    });
    expect(summary).toEqual({
      students: 0,
      days: 0,
      studentRows: 0,
      geoRows: 0,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects a reversed range', async () => {
    const { deps } = makeDeps(FIXTURE);
    await expect(
      backfillUsage(deps, {
        from: '2026-06-03',
        to: '2026-06-02',
        dryRun: true,
      }),
    ).rejects.toThrow('from (2026-06-03) is after to (2026-06-02)');
  });
});
