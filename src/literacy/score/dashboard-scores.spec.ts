import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DashboardScoresService } from './dashboard-scores.service';
import {
  binOf,
  compareStudents,
  delta,
  passRate,
  populationSd,
  studentLabel,
  toCsv,
  usingLifteracy,
  validateMetric,
  validateRange,
  type ChildRow,
  type StudentRow,
} from './dashboard-scores.dto';
import type { GeoEntityService } from '../../geo-entities/geo-entity.service';

// ─── Arithmetic ──────────────────────────────────────────────────────────────

describe('dashboard-scores arithmetic', () => {
  it('passRate: pass/n × 100 to 1 dp, null at n = 0', () => {
    expect(passRate(3, 4)).toBe(75);
    expect(passRate(2, 3)).toBe(66.7);
    expect(passRate(0, 0)).toBeNull();
  });

  it('populationSd from sum/sumsq; 0 at n ≤ 1; null at n = 0', () => {
    // scores 0.25, 0.75 → mean 0.5, sd 0.25
    expect(populationSd(1, 0.625, 2)).toBeCloseTo(0.25, 10);
    expect(populationSd(0.75, 0.5625, 1)).toBe(0);
    expect(populationSd(0, 0, 0)).toBeNull();
    // Rounding noise must never produce NaN.
    expect(populationSd(1, 0.4999999999, 2)).toBe(0);
  });

  it('delta: latest − prior to 1 dp, null when either is missing', () => {
    expect(delta(75, 60.4)).toBe(14.6);
    expect(delta(75, null)).toBeNull();
    expect(delta(75, undefined)).toBeNull();
    expect(delta(null, 60)).toBeNull();
  });

  it('bins: high ≥ 80, mid 50–79, low < 50, none when unused or n = 0', () => {
    expect(binOf(80, true)).toBe('high');
    expect(binOf(79.9, true)).toBe('mid');
    expect(binOf(50, true)).toBe('mid');
    expect(binOf(49.9, true)).toBe('low');
    expect(binOf(null, true)).toBe('none');
    expect(binOf(90, false)).toBe('none');
  });

  it('usingLifteracy counts scored + unbanded, not active', () => {
    expect(usingLifteracy({ students_scored: 0, students_unbanded: 0 })).toBe(
      false,
    );
    expect(usingLifteracy({ students_scored: 3, students_unbanded: 0 })).toBe(
      true,
    );
    expect(usingLifteracy({ students_scored: 0, students_unbanded: 1 })).toBe(
      true,
    );
    expect(usingLifteracy(undefined)).toBe(false);
  });

  it('validators', () => {
    expect(validateMetric('mpl_b')).toBe('mpl_b');
    expect(() => validateMetric('nipun')).toThrow(/metric must be one of/);
    expect(validateRange(undefined)).toBe(30);
    expect(validateRange('90')).toBe(90);
    expect(() => validateRange('60')).toThrow(/range must be one of/);
  });

  it('studentLabel: first name, else a stable ordinal', () => {
    expect(studentLabel('Asha Kumari', 3)).toBe('Asha');
    expect(studentLabel('  ', 3)).toBe('Student 3');
    expect(studentLabel(null, 12)).toBe('Student 12');
  });

  it('compareStudents: scored desc, then unscored by last_active_at desc, then neither', () => {
    const s = (
      label: string,
      score: number | null,
      last: string | null,
    ): StudentRow => ({
      student_id: label,
      label,
      score,
      passed: null,
      attempts: 0,
      in_band: true,
      active: false,
      last_active_at: last,
    });
    const rows = [
      s('neither', null, null),
      s('recent', null, '2026-09-10T00:00:00Z'),
      s('low', 0.25, null),
      s('old', null, '2026-08-01T00:00:00Z'),
      s('high', 0.75, null),
    ];
    expect(rows.sort(compareStudents).map((r) => r.label)).toEqual([
      'high',
      'low',
      'recent',
      'old',
      'neither',
    ]);
  });

  it('toCsv escapes and handles an empty list', () => {
    expect(toCsv([])).toBe('');
    expect(
      toCsv([
        { a: 1, b: 'x,y', c: null },
        { a: 2, b: 'q"r', c: { z: 1 } },
      ]),
    ).toBe('a,b,c\n1,"x,y",\n2,"q""r","{""z"":1}"');
  });
});

// ─── Service over an in-memory database ──────────────────────────────────────

const AS_OF = '2026-09-13';
const D = {
  id: 'D',
  type: 'district',
  code: '0101',
  name: 'Kupwara',
  has_boundary: true,
  lat: null,
  lng: null,
  status: 'operational',
  deleted_at: null,
};
const B1 = {
  id: 'B1',
  type: 'block',
  code: '010101',
  name: 'Kupwara',
  has_boundary: false,
  lat: 34.5,
  lng: 74.4,
  status: 'operational',
  deleted_at: null,
};
const B2 = {
  id: 'B2',
  type: 'block',
  code: '010102',
  name: 'Handwara',
  has_boundary: false,
  lat: null,
  lng: null,
  status: 'operational',
  deleted_at: null,
};
const S1 = {
  id: 'S1',
  type: 'school',
  code: '01010100101',
  name: 'PS Kupwara',
  has_boundary: false,
  lat: 34.51,
  lng: 74.41,
  status: 'operational',
  deleted_at: null,
};
const S2 = {
  id: 'S2',
  type: 'school',
  code: '01010100102',
  name: 'MS Kupwara',
  has_boundary: false,
  lat: null,
  lng: null,
  status: 'operational',
  deleted_at: null,
};
const S9 = {
  id: 'S9',
  type: 'school',
  code: '01010100199',
  name: 'Empty School',
  has_boundary: false,
  lat: null,
  lng: null,
  status: 'operational',
  deleted_at: null,
};

type GeoRow = {
  geo_entity_id: string;
  computed_for: string;
  n: number;
  pass: number;
  sum: number;
  sumsq: number;
  students_active: number;
  students_scored: number;
  students_unbanded: number;
};

function geoRow(
  id: string,
  date: string,
  n: number,
  pass: number,
  scores: number[],
  extra: Partial<GeoRow> = {},
): GeoRow {
  const sum = scores.reduce((a, b) => a + b, 0);
  const sumsq = scores.reduce((a, b) => a + b * b, 0);
  return {
    geo_entity_id: id,
    computed_for: date,
    n,
    pass,
    sum,
    sumsq,
    students_active: n,
    students_scored: n,
    students_unbanded: 0,
    ...extra,
  };
}

interface StudentFixture {
  student_id: string;
  name: string | null;
  created_at: string;
  birth_year: number | null;
  birth_month: number | null;
  rows: Array<{
    geo: string;
    created_at: string;
    score: number | null;
    passed: boolean | null;
    attempts: number;
  }>;
  last_active_at: string | null;
  referrer_geo?: string; // deliberately NOT used by the membership rule
}

function makeService(fixture: {
  entities: Record<string, unknown>[];
  geoRows: GeoRow[];
  officials?: Array<{
    geo_entity_id: string;
    name: string;
    role_title: string;
    avatar_seed: string;
    spotlight_message: string | null;
    created_at: string;
  }>;
  students?: StudentFixture[];
}) {
  const byId = new Map(
    fixture.entities.map((e) => [(e as { id: string }).id, e]),
  );
  const children = (id: string, type: string) =>
    fixture.entities.filter(
      (e) =>
        (e as { parent_id?: string }).parent_id === id &&
        (e as { type: string }).type === type,
    );
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    const tag = /\/\* ([a-z-]+:[a-z-]+) \*\//.exec(sql)?.[1];
    switch (tag) {
      case 'dashboard-scores:latest': {
        return fixture.geoRows
          .filter((r) => r.geo_entity_id === params[0])
          .sort((a, b) => (a.computed_for < b.computed_for ? 1 : -1))
          .slice(0, 1);
      }
      case 'dashboard-scores:prior': {
        const ids = params[0] as string[];
        const cutoff =
          new Date(`${params[1] as string}T00:00:00Z`).getTime() -
          Number(params[2]) * 86_400_000;
        const out: GeoRow[] = [];
        for (const id of ids) {
          const row = fixture.geoRows
            .filter(
              (r) =>
                r.geo_entity_id === id &&
                new Date(`${r.computed_for}T00:00:00Z`).getTime() <= cutoff,
            )
            .sort((a, b) => (a.computed_for < b.computed_for ? 1 : -1))[0];
          if (row) out.push(row);
        }
        return out;
      }
      case 'dashboard-scores:series': {
        const cutoff =
          new Date(`${params[1] as string}T00:00:00Z`).getTime() -
          Number(params[2]) * 86_400_000;
        return fixture.geoRows
          .filter((r) => r.geo_entity_id === params[0])
          .filter((r) => {
            const t = new Date(`${r.computed_for}T00:00:00Z`).getTime();
            return (
              t > cutoff &&
              t <= new Date(`${params[1] as string}T00:00:00Z`).getTime()
            );
          })
          .sort((a, b) => (a.computed_for < b.computed_for ? -1 : 1));
      }
      case 'dashboard-scores:children': {
        const ids = params[0] as string[];
        return fixture.geoRows.filter(
          (r) => ids.includes(r.geo_entity_id) && r.computed_for === params[1],
        );
      }
      case 'dashboard-scores:officials': {
        const ids = params[0] as string[];
        const latest = new Map<string, unknown>();
        for (const o of [...(fixture.officials ?? [])].sort((a, b) =>
          a.created_at < b.created_at ? 1 : -1,
        )) {
          if (ids.includes(o.geo_entity_id) && !latest.has(o.geo_entity_id))
            latest.set(o.geo_entity_id, o);
        }
        return [...latest.values()].map((o) => {
          const { created_at: _c, ...rest } = o as Record<string, unknown>;
          return rest;
        });
      }
      case 'dashboard-scores:students': {
        const school = params[0] as string;
        const metric = /l\.(\w+)_score::float8/.exec(sql)![1];
        expect(metric).toBe('nipun_g2');
        return (fixture.students ?? [])
          .filter((s) => s.rows.some((r) => r.geo === school))
          .map((s) => ({
            s,
            latest: [...s.rows].sort((a, b) =>
              a.created_at < b.created_at ? 1 : -1,
            )[0],
          }))
          .filter(({ latest }) => latest.geo === school)
          .map(({ s, latest }) => ({
            student_id: s.student_id,
            name: s.name,
            created_at: new Date(s.created_at),
            birth_year: s.birth_year,
            birth_month: s.birth_month,
            score: latest.score,
            passed: latest.passed,
            attempts: latest.attempts,
            last_active_at: s.last_active_at
              ? new Date(s.last_active_at)
              : null,
          }));
      }
      default:
        throw new Error(`unexpected SQL ${tag ?? sql.slice(0, 40)}`);
    }
  });
  const geo = {
    getById: jest.fn(async (id: string) => byId.get(id) ?? null),
    descendants: jest.fn(
      async (
        id: string,
        type: string,
        opts: { cursor: string | null; limit: number },
      ) => {
        const items = children(id, type)
          .filter(
            (e) =>
              opts.cursor === null || (e as { id: string }).id > opts.cursor,
          )
          .slice(0, opts.limit);
        return { items, next_cursor: null };
      },
    ),
  };
  return {
    svc: new DashboardScoresService(
      { query } as unknown as DataSource,
      geo as unknown as GeoEntityService,
    ),
    query,
    geo,
  };
}

const ENTITIES = [
  { ...D, parent_id: null },
  { ...B1, parent_id: 'D' },
  { ...B2, parent_id: 'D' },
  { ...S1, parent_id: 'B1' },
  { ...S2, parent_id: 'B1' },
  { ...S9, parent_id: 'B1' },
];

describe('DashboardScoresService.scores — geo levels', () => {
  const fixture = () => ({
    entities: ENTITIES,
    geoRows: [
      geoRow('B1', AS_OF, 4, 3, [0.75, 1, 0.5, 0.75]),
      geoRow('B1', '2026-08-10', 4, 2, [0.5, 0.5, 0.75, 0.25]),
      geoRow('B1', '2026-09-01', 4, 4, [1, 1, 1, 1]),
      geoRow('S1', AS_OF, 3, 3, [1, 0.75, 1], { students_active: 2 }),
      geoRow('S1', '2026-08-01', 3, 1, [0.25, 0.5, 0.25]),
      geoRow('S2', AS_OF, 0, 0, [], {
        students_active: 0,
        students_scored: 0,
        students_unbanded: 2,
      }),
      geoRow('S2', '2026-07-01', 2, 2, [1, 1]),
    ],
    officials: [
      {
        geo_entity_id: 'S1',
        name: 'Old Teacher',
        role_title: 'Teacher',
        avatar_seed: 'old',
        spotlight_message: null,
        created_at: '2026-01-01',
      },
      {
        geo_entity_id: 'S1',
        name: 'Asha',
        role_title: 'Teacher',
        avatar_seed: 'asha',
        spotlight_message: 'Read daily!',
        created_at: '2026-06-01',
      },
      {
        geo_entity_id: 'S2',
        name: 'Ravi',
        role_title: 'Teacher',
        avatar_seed: 'ravi',
        spotlight_message: null,
        created_at: '2026-06-01',
      },
    ],
  });

  it('block level: root stats, series within range, delta against the row ≤ as_of − range, children = its schools in one hop', async () => {
    const { svc, geo } = makeService(fixture());
    const out = await svc.scores('B1', 'nipun_g2', 30);
    expect(out.as_of).toBe(AS_OF);
    expect(out.entity).toEqual({
      id: 'B1',
      type: 'block',
      code: '010101',
      name: 'Kupwara',
      has_boundary: false,
      lat: 34.5,
      lng: 74.4,
    });
    expect(out.root.pass_rate).toBe(75);
    expect(out.root.n).toBe(4);
    expect(out.root.mean).toBeCloseTo(0.75, 10);
    expect(out.root.sd).toBeCloseTo(
      Math.sqrt((0.5625 + 1 + 0.25 + 0.5625) / 4 - 0.5625),
      10,
    );
    // 30-day delta: newest row ≤ 2026-08-14 is 2026-08-10 (50%) → +25.
    expect(out.root.delta).toBe(25);
    expect(out.series.map((p) => p.date)).toEqual(['2026-09-01', AS_OF]);
    expect(out.child_type).toBe('school');
    expect(geo.descendants).toHaveBeenCalledTimes(1);
    expect(geo.descendants).toHaveBeenCalledWith('B1', 'school', {
      cursor: null,
      limit: 500,
    });

    const children = out.children as ChildRow[];
    expect(children.map((c) => c.id)).toEqual(['S1', 'S2', 'S9']);
    const s1 = children[0];
    expect(s1).toEqual(
      expect.objectContaining({
        pass_rate: 100,
        n: 3,
        students_active: 2,
        using_lifteracy: true,
        bin: 'high',
        delta: 66.7,
      }),
    );
    // official is on every child and is the NEWEST education_official.
    expect(s1.official).toEqual({
      name: 'Asha',
      role_title: 'Teacher',
      avatar_seed: 'asha',
      spotlight_message: 'Read daily!',
    });
    // S2: a row at as_of with only unbanded students → uses Lifteracy, n = 0 → bin none.
    const s2 = children[1];
    expect(s2).toEqual(
      expect.objectContaining({
        pass_rate: null,
        n: 0,
        using_lifteracy: true,
        bin: 'none',
        delta: null,
      }),
    );
    expect(s2.official?.name).toBe('Ravi');
    // S9: no row at all → not using Lifteracy, official null.
    expect(children[2]).toEqual(
      expect.objectContaining({
        using_lifteracy: false,
        bin: 'none',
        n: 0,
        official: null,
      }),
    );
    // most_improved needs n ≥ 5: nobody qualifies here.
    expect(out.most_improved).toEqual([]);
  });

  it('90-day range picks an older prior row, and most_improved orders by delta with n ≥ 5', async () => {
    const f = fixture();
    f.geoRows.push(geoRow('S1', '2026-06-01', 3, 0, [0, 0.25, 0]));
    f.geoRows.push(geoRow('S9', AS_OF, 6, 3, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]));
    f.geoRows.push(geoRow('S9', '2026-06-01', 6, 6, [1, 1, 1, 1, 1, 1]));
    f.geoRows.push(geoRow('S2', AS_OF, 5, 4, [1, 1, 1, 1, 0.25]));
    f.geoRows.splice(
      f.geoRows.findIndex(
        (r) => r.geo_entity_id === 'S2' && r.students_unbanded === 2,
      ),
      1,
    );
    const { svc } = makeService(f);
    const out = await svc.scores('B1', 'nipun_g2', 90);
    // B1 prior for 90 days: newest ≤ 2026-06-15 → none → null.
    expect(out.root.delta).toBeNull();
    expect(out.most_improved.map((c) => [c.id, c.delta])).toEqual([
      ['S9', -50],
    ]);
    const s2 = (out.children as ChildRow[]).find((c) => c.id === 'S2')!;
    expect(s2.n).toBe(5);
    // S2's only older row is 2026-07-01, AFTER as_of − 90 days → no prior.
    expect(s2.delta).toBeNull();
  });

  it('empty root: 200 with nulls, no children, no series', async () => {
    const { svc, query } = makeService({ entities: ENTITIES, geoRows: [] });
    const out = await svc.scores('S9', 'nipun_g2', 30);
    expect(out).toEqual({
      as_of: null,
      metric: 'nipun_g2',
      range: 30,
      entity: expect.objectContaining({ id: 'S9' }),
      root: {
        pass_rate: null,
        mean: null,
        sd: null,
        n: null,
        students_active: null,
        students_unbanded: null,
        delta: null,
      },
      series: [],
      child_type: 'student',
      children: [],
      most_improved: [],
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('404s for an unknown entity', async () => {
    const { svc } = makeService({ entities: ENTITIES, geoRows: [] });
    await expect(svc.scores('nope', 'nipun_g2', 30)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('DashboardScoresService.spotlight', () => {
  it('top by pass_rate and most_improved by delta among n ≥ 5, each with its official; range defaults to 30 in the controller', async () => {
    const f = {
      entities: ENTITIES,
      geoRows: [
        geoRow('B1', AS_OF, 12, 9, Array(12).fill(0.75)),
        geoRow('S1', AS_OF, 6, 6, Array(6).fill(1)),
        geoRow('S1', '2026-08-01', 6, 3, Array(6).fill(0.5)),
        geoRow('S2', AS_OF, 6, 3, Array(6).fill(0.5)),
        geoRow('S2', '2026-08-01', 6, 0, Array(6).fill(0.25)),
      ],
      officials: [
        {
          geo_entity_id: 'S2',
          name: 'Ravi',
          role_title: 'Teacher',
          avatar_seed: 'ravi',
          spotlight_message: 'Hi',
          created_at: '2026-06-01',
        },
      ],
    };
    const { svc } = makeService(f);
    const out = await svc.spotlight('B1', 'nipun_g2', 30);
    expect(out.top?.child.id).toBe('S1');
    expect(out.top?.official).toBeNull();
    // S1 delta +50, S2 delta +50 — ties keep input (id) order → S1 first.
    expect(out.most_improved?.child.id).toBe('S1');
    expect(out.most_improved?.child.delta).toBe(50);
  });

  it('is empty at school level', async () => {
    const { svc } = makeService({
      entities: ENTITIES,
      geoRows: [geoRow('S1', AS_OF, 6, 6, Array(6).fill(1))],
      students: [],
    });
    await expect(svc.spotlight('S1', 'nipun_g2', 30)).resolves.toEqual({
      top: null,
      most_improved: null,
    });
  });
});

describe('DashboardScoresService.scores — school level (students)', () => {
  const students: StudentFixture[] = [
    {
      student_id: 'st-b',
      name: 'Bittu Yadav',
      created_at: '2026-02-01',
      birth_year: 2018,
      birth_month: 7,
      rows: [
        {
          geo: 'S1',
          created_at: '2026-09-13',
          score: 0.5,
          passed: false,
          attempts: 4,
        },
      ],
      last_active_at: '2026-09-12T00:00:00Z',
    },
    {
      student_id: 'st-a',
      name: null,
      created_at: '2026-01-01',
      birth_year: 2018,
      birth_month: 7,
      rows: [
        {
          geo: 'S1',
          created_at: '2026-09-13',
          score: 1,
          passed: true,
          attempts: 4,
        },
      ],
      last_active_at: '2026-08-01T00:00:00Z',
    },
    // Unscored, active recently.
    {
      student_id: 'st-c',
      name: null,
      created_at: '2026-03-01',
      birth_year: 2016,
      birth_month: 1,
      rows: [
        {
          geo: 'S1',
          created_at: '2026-09-13',
          score: null,
          passed: null,
          attempts: 1,
        },
      ],
      last_active_at: '2026-09-11T00:00:00Z',
    },
    // Unscored, never active.
    {
      student_id: 'st-d',
      name: null,
      created_at: '2026-04-01',
      birth_year: null,
      birth_month: null,
      rows: [
        {
          geo: 'S1',
          created_at: '2026-09-13',
          score: null,
          passed: null,
          attempts: 0,
        },
      ],
      last_active_at: null,
    },
    // Moved: has an OLD row at S1 but the latest row is at another school →
    // not a member here, whatever the referrer says now.
    {
      student_id: 'st-moved',
      name: 'Gone',
      created_at: '2026-01-15',
      birth_year: 2018,
      birth_month: 7,
      rows: [
        {
          geo: 'S1',
          created_at: '2026-08-01',
          score: 1,
          passed: true,
          attempts: 4,
        },
        {
          geo: 'S2',
          created_at: '2026-09-13',
          score: 1,
          passed: true,
          attempts: 4,
        },
      ],
      last_active_at: '2026-09-12T00:00:00Z',
      referrer_geo: 'S1',
    },
  ];
  const fixture = () => ({
    entities: ENTITIES,
    geoRows: [geoRow('S1', AS_OF, 2, 1, [1, 0.5])],
    students,
  });

  it('lists members by compute-time school, ordered scored desc → unscored by last_active_at → neither; labels never contain phone digits', async () => {
    const { svc } = makeService(fixture());
    const out = await svc.scores('S1', 'nipun_g2', 30);
    expect(out.child_type).toBe('student');
    const rows = out.children as StudentRow[];
    expect(rows.map((r) => r.student_id)).toEqual([
      'st-a',
      'st-b',
      'st-c',
      'st-d',
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      'Student 1',
      'Bittu',
      'Student 3',
      'Student 4',
    ]);
    for (const r of rows) expect(r.label).not.toMatch(/\d{5,}/);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        score: 1,
        passed: true,
        attempts: 4,
        in_band: true,
        active: false,
      }),
    );
    expect(rows[1].active).toBe(true);
    // st-c is 10 on 2026-09-13 → outside nipun_g2 [7, 9).
    expect(rows[2].in_band).toBe(false);
    expect(rows[3]).toEqual(
      expect.objectContaining({
        in_band: false,
        active: false,
        last_active_at: null,
      }),
    );
    expect(rows.find((r) => r.student_id === 'st-moved')).toBeUndefined();
  });

  it('labels are stable across two calls', async () => {
    const { svc } = makeService(fixture());
    const a = (await svc.scores('S1', 'nipun_g2', 30)).children as StudentRow[];
    const b = (await svc.scores('S1', 'nipun_g2', 30)).children as StudentRow[];
    expect(a.map((r) => [r.student_id, r.label])).toEqual(
      b.map((r) => [r.student_id, r.label]),
    );
  });
});
