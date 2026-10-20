import { maskPii, visibilityOf } from '../../users/pii-mask';
import type {
  ChildRow,
  GeoRef,
  Official,
  RankLevel,
  RankRow,
  RankingsResponse,
  ScoresResponse,
  StudentRow,
} from './dashboard-scores.dto';

// Per-viewer masking of the personal data in a scores / rankings response,
// applied by DashboardScoresService before anything leaves pp-sketch. Pure:
// the decision of WHO is visible is PiiAccessService's; this only applies it.
//
// `publicView` = the general public is looking (an anonymous viewer — the
// donor page). Then teachers' and officials' NAMES are masked too and their
// spotlight message (free text) is withheld; a /d link holder still sees
// every teacher's and official's name, as before.

// The stand-in name of a teacher without one (dashboard-scores.service.ts):
// identifies nobody, so it is never masked.
export const TEACHER_FALLBACK_NAME = 'Teacher';

export const maskTeacherName = (name: string): string =>
  name === TEACHER_FALLBACK_NAME ? name : maskPii(name);

// A drill ref naming a teacher (type 'teacher', name = the teacher's name).
const maskTeacherRef = <R extends GeoRef>(ref: R): R =>
  ref.type === 'teacher' ? { ...ref, name: maskTeacherName(ref.name) } : ref;

const isStudentRows = (rows: ChildRow[] | StudentRow[]): rows is StudentRow[] =>
  rows.length > 0 && 'student_id' in rows[0];

// Every user whose personal data the response carries: the students of a
// class, and the official (or teacher) on each child row.
export function piiSubjects(response: ScoresResponse): string[] {
  const ids: string[] = [];
  if (isStudentRows(response.children)) {
    for (const s of response.children) ids.push(s.student_id);
  } else {
    for (const c of response.children) if (c.official) ids.push(c.official.id);
  }
  for (const c of response.most_improved)
    if (c.official) ids.push(c.official.id);
  return ids;
}

export function redactStudent(
  row: StudentRow,
  visible: ReadonlySet<string>,
): StudentRow {
  const full = visible.has(row.student_id);
  if (full) return { ...row, pii: 'full' };
  return {
    ...row,
    // The label is the first name when there is one ("Student N" otherwise,
    // which identifies nobody and stays as is).
    label: row.name ? maskPii(row.label) : row.label,
    name: maskPii(row.name),
    phone: maskPii(row.phone),
    pii: 'masked',
  };
}

// Names of officials and teachers stay visible to every /d link holder;
// only their phone number follows the one-hop rule. The general public
// (`publicView`) gets the name masked and no spotlight message.
export function redactOfficial(
  official: Official | null,
  visible: ReadonlySet<string>,
  publicView = false,
): Official | null {
  if (!official) return null;
  const full = visible.has(official.id);
  return {
    ...official,
    ...(publicView && !full
      ? { name: maskPii(official.name), spotlight_message: null }
      : {}),
    phone: full ? official.phone : maskPii(official.phone),
    pii: visibilityOf(full),
  };
}

// A teacher row (school level) carries the teacher's name as the row name
// too; an unnamed teacher's is the fallback and stays.
const redactChild = (
  row: ChildRow,
  visible: ReadonlySet<string>,
  publicView: boolean,
): ChildRow => ({
  ...row,
  ...(publicView && row.type === 'teacher' && !visible.has(row.id)
    ? { name: row.official?.name ? maskTeacherName(row.name) : row.name }
    : {}),
  official: redactOfficial(row.official, visible, publicView),
});

export function redactScores(
  response: ScoresResponse,
  visible: ReadonlySet<string>,
  publicView = false,
): ScoresResponse {
  return {
    ...response,
    // a teacher's class: the entity is the teacher
    entity: publicView ? maskTeacherRef(response.entity) : response.entity,
    children: isStudentRows(response.children)
      ? response.children.map((s) => redactStudent(s, visible))
      : response.children.map((c) => redactChild(c, visible, publicView)),
    most_improved: response.most_improved.map((c) =>
      redactChild(c, visible, publicView),
    ),
  };
}

// ─── Rankings ─────────────────────────────────────────────────────────────

// Whose personal data a rankings response carries: the teachers (name +
// number) at the teacher level, the students (name) at the student level.
export function rankingSubjects(response: RankingsResponse): string[] {
  if (response.level !== 'teacher' && response.level !== 'student') return [];
  return [...response.top, ...response.most_improved].map((r) => r.id);
}

// The same rules as the scores response: a student's name and a teacher's
// number in full only for the viewer directly above them; a teacher's name
// masked for the general public. `named` = the students that HAVE a stored
// name (an unnamed student's "Student N" label identifies nobody).
function redactRankRow(
  row: RankRow,
  level: RankLevel,
  visible: ReadonlySet<string>,
  publicView: boolean,
  named: ReadonlySet<string>,
): RankRow {
  const path = publicView ? row.path.map(maskTeacherRef) : row.path;
  const full = visible.has(row.id);
  if (level === 'teacher') {
    return {
      ...row,
      name: publicView && !full ? maskTeacherName(row.name) : row.name,
      sub: full ? row.sub : maskPii(row.sub),
      path,
    };
  }
  if (level === 'student') {
    return {
      ...row,
      name: !full && named.has(row.id) ? maskPii(row.name) : row.name,
      sub: null,
      path,
    };
  }
  return { ...row, path };
}

export function redactRankings(
  response: RankingsResponse,
  visible: ReadonlySet<string>,
  publicView: boolean,
  named: ReadonlySet<string>,
): RankingsResponse {
  const one = (r: RankRow) =>
    redactRankRow(r, response.level, visible, publicView, named);
  return {
    ...response,
    top: response.top.map(one),
    most_improved: response.most_improved.map(one),
  };
}
