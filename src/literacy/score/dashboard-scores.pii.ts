import { maskPii, visibilityOf } from '../../users/pii-mask';
import type {
  ChildRow,
  Official,
  ScoresResponse,
  StudentRow,
} from './dashboard-scores.dto';

// Per-viewer masking of the personal data in a scores response, applied by
// DashboardScoresService before anything leaves pp-sketch. Pure: the
// decision of WHO is visible is PiiAccessService's; this only applies it.

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

// Names of officials and teachers stay visible to everyone on the
// dashboard; only their phone number follows the one-hop rule.
export function redactOfficial(
  official: Official | null,
  visible: ReadonlySet<string>,
): Official | null {
  if (!official) return null;
  const full = visible.has(official.id);
  return {
    ...official,
    phone: full ? official.phone : maskPii(official.phone),
    pii: visibilityOf(full),
  };
}

const redactChild = (
  row: ChildRow,
  visible: ReadonlySet<string>,
): ChildRow => ({
  ...row,
  official: redactOfficial(row.official, visible),
});

export function redactScores(
  response: ScoresResponse,
  visible: ReadonlySet<string>,
): ScoresResponse {
  return {
    ...response,
    children: isStudentRows(response.children)
      ? response.children.map((s) => redactStudent(s, visible))
      : response.children.map((c) => redactChild(c, visible)),
    most_improved: response.most_improved.map((c) => redactChild(c, visible)),
  };
}
