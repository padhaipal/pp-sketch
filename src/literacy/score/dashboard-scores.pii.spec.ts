import {
  piiSubjects,
  redactOfficial,
  redactRankings,
  redactScores,
  redactStudent,
} from './dashboard-scores.pii';
import type {
  ChildRow,
  Official,
  RankRow,
  ScoresResponse,
  StudentRow,
} from './dashboard-scores.dto';

const official = (
  id: string,
  phone: string | null = '919999990001',
): Official => ({
  id,
  name: 'Asha',
  role_title: 'Teacher',
  avatar_seed: 'asha',
  spotlight_message: null,
  phone,
  pii: 'full',
});
const child = (id: string, off: Official | null): ChildRow =>
  ({
    id,
    type: 'school',
    code: '1',
    name: 'S',
    has_boundary: false,
    lat: null,
    lng: null,
    pass_rate: null,
    n: 0,
    students_active: 0,
    using_lifteracy: false,
    delta: null,
    bin: 'none',
    official: off,
  }) as ChildRow;
const student = (id: string, name: string | null, label: string): StudentRow =>
  ({
    student_id: id,
    label,
    phone: '919999990011',
    name,
    pii: 'full',
    score: null,
    passed: null,
    attempts: 0,
    in_band: true,
    active: false,
    last_active_at: null,
    delta: null,
  }) as StudentRow;
const response = (
  children: ChildRow[] | StudentRow[],
  most_improved: ChildRow[] = [],
) => ({ children, most_improved }) as unknown as ScoresResponse;

describe('piiSubjects', () => {
  it('collects student ids at class level, official ids elsewhere, plus most-improved officials', () => {
    expect(
      piiSubjects(
        response([student('s1', null, 'Student 1'), student('s2', 'R', 'R')]),
      ),
    ).toEqual(['s1', 's2']);
    expect(
      piiSubjects(
        response(
          [child('g1', official('o1')), child('g2', null)],
          [child('g3', official('o3'))],
        ),
      ),
    ).toEqual(['o1', 'o3']);
    expect(piiSubjects(response([]))).toEqual([]);
  });
});

describe('redactStudent', () => {
  it('visible → as stored, pii full', () => {
    expect(
      redactStudent(student('s1', 'Rani Devi', 'Rani'), new Set(['s1'])),
    ).toEqual(
      expect.objectContaining({
        name: 'Rani Devi',
        label: 'Rani',
        phone: '919999990011',
        pii: 'full',
      }),
    );
  });
  it('hidden → name, label and phone masked; an unnamed student keeps "Student N"', () => {
    expect(
      redactStudent(student('s1', 'Rani Devi', 'Rani'), new Set()),
    ).toEqual(
      expect.objectContaining({
        name: 'R...i',
        label: 'R...i',
        phone: '9...1',
        pii: 'masked',
      }),
    );
    expect(redactStudent(student('s2', null, 'Student 2'), new Set())).toEqual(
      expect.objectContaining({
        name: null,
        label: 'Student 2',
        phone: '9...1',
        pii: 'masked',
      }),
    );
  });
  it('general public → name, label and phone empty (not masked), named or not', () => {
    for (const s of [
      student('s1', 'Rani Devi', 'Rani'),
      student('s2', null, 'Student 2'),
    ]) {
      expect(redactStudent(s, new Set(), true)).toEqual(
        expect.objectContaining({
          name: '',
          label: '',
          phone: '',
          pii: 'masked',
        }),
      );
    }
  });
});

describe('redactRankings — student level', () => {
  const row = (id: string, name: string): RankRow =>
    ({ id, name, sub: null, value: 50, delta: null, path: [] }) as RankRow;
  const response = {
    level: 'student' as const,
    as_of: null,
    top: [row('s1', 'Rani Devi'), row('s2', 'Student 2')],
    most_improved: [row('s1', 'Rani Devi')],
  };
  it('general public → every student name empty', () => {
    const out = redactRankings(response, new Set(), true, new Set(['s1']));
    expect([...out.top, ...out.most_improved].map((r) => r.name)).toEqual([
      '',
      '',
      '',
    ]);
  });
  it('a /d link holder → named students masked, "Student N" kept', () => {
    const out = redactRankings(response, new Set(), false, new Set(['s1']));
    expect(out.top.map((r) => r.name)).toEqual(['R...i', 'Student 2']);
  });
});

describe('redactOfficial', () => {
  it('keeps the name either way; masks only the phone when hidden; null stays null', () => {
    expect(redactOfficial(official('o1'), new Set(['o1']))).toEqual(
      expect.objectContaining({
        name: 'Asha',
        phone: '919999990001',
        pii: 'full',
      }),
    );
    expect(redactOfficial(official('o1'), new Set())).toEqual(
      expect.objectContaining({ name: 'Asha', phone: '9...1', pii: 'masked' }),
    );
    expect(redactOfficial(official('o1', null), new Set())).toEqual(
      expect.objectContaining({ phone: null, pii: 'masked' }),
    );
    expect(redactOfficial(null, new Set())).toBeNull();
  });
});

describe('redactScores', () => {
  it('applies to children (either shape) and most_improved, leaving the rest of the response alone', () => {
    const geo = response(
      [child('g1', official('o1')), child('g2', null)],
      [child('g1', official('o1'))],
    );
    const out = redactScores(
      { ...geo, as_of: '2026-09-18' } as ScoresResponse,
      new Set(),
    );
    expect(out.as_of).toBe('2026-09-18');
    expect(
      (out.children as ChildRow[]).map((c) => c.official?.phone ?? null),
    ).toEqual(['9...1', null]);
    expect(out.most_improved[0].official?.pii).toBe('masked');

    const cls = redactScores(
      response([student('s1', 'Rani', 'Rani')]),
      new Set(['s1']),
    );
    expect((cls.children as StudentRow[])[0].pii).toBe('full');
  });
});
