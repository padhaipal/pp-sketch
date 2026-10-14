/**
 * Pure helpers for the /users/interactions.csv export — one CSV row per
 * literacy_lesson_states turn. Kept free of Nest/DB imports so the format
 * (escaping, header order, footer) is unit-testable in isolation.
 *
 * Privacy: the file identifies people by users.id only — never a name or
 * phone number. The student's and teacher's names are read from the DB
 * solely to feed censorTranscript (the same pass every dashboard viewer
 * gets on users/:id/media) and are dropped before the row is serialized
 * (anonymiseInteractionRow). The teacher's geo entity (school/block) name
 * is kept: it is a place, not a person.
 *
 * Format decisions:
 *  - UTF-8 BOM + CRLF line endings so Excel renders Devanagari correctly.
 *  - Timestamps are IST (formatted in SQL), matching the dashboard buckets.
 *  - Rows stream oldest-first, so a cut-off download is still a valid file;
 *    the trailing `# export complete, N rows` marker distinguishes a full
 *    export from a truncated one (resume = re-run with from = last row's ts).
 */

/** Rows fetched per keyset batch; bounds both query time and memory. */
export const INTERACTIONS_BATCH_SIZE = 5000;

import { censorTranscript } from './transcript-censor';

export const CSV_BOM = '\uFEFF';
export const CSV_EOL = '\r\n';

/** One anonymised row of the export (user.service.findInteractionsPage). */
export interface InteractionRow {
  lesson_state_id: string;
  created_at: Date;
  timestamp_ist: string;
  /** users.id of the student — the only student identifier in the file. */
  student_id: string;
  /** users.id of the referring teacher (users.referrer_user_id), if any. */
  referred_by_id: string | null;
  /** The teacher's CURRENT geo entity (users.geo_entity_id → geo_entity). */
  geo_entity_type: string | null;
  geo_entity_name: string | null;
  level: number | null;
  lesson_type: 'word' | 'passage';
  content: string | null;
  correct_answer: string | null;
  answer_correct: boolean | null;
  sarvam_transcript: string | null;
  azure_transcript: string | null;
  reverie_transcript: string | null;
  bodhan_transcript: string | null;
  /** Real container-parsed voice-note length (media_details.duration_ms,
   * see audio-duration.utils.ts) — never a file-size estimate. Null for
   * flow-tap turns (no recording) and pre-capture historic rows. */
  audio_duration_ms: number | null;
  score_change: string | null;
  letters_touched: string | null;
  starting_state: string | null;
  final_state: string | null;
  state_transition_id: string | null;
  passage_id: string | null;
  user_message_id: string;
}

/**
 * What the SQL returns: the anonymised row plus the two names needed to
 * censor the transcripts. Never serialized — see anonymiseInteractionRow.
 */
export interface InteractionSourceRow extends InteractionRow {
  student_name: string | null;
  referred_by_name: string | null;
}

/**
 * Drops the names and runs every STT transcript through censorTranscript
 * with them as known names (plus its phone-number / "mera naam …" passes),
 * exactly as users/:id/media does for an official viewing a student.
 */
export function anonymiseInteractionRow(
  src: InteractionSourceRow,
): InteractionRow {
  const { student_name, referred_by_name, ...row } = src;
  const names = [student_name, referred_by_name];
  const censor = (t: string | null): string | null =>
    t == null ? null : censorTranscript(t, names).text;
  return {
    ...row,
    sarvam_transcript: censor(row.sarvam_transcript),
    azure_transcript: censor(row.azure_transcript),
    reverie_transcript: censor(row.reverie_transcript),
    bodhan_transcript: censor(row.bodhan_transcript),
  };
}

export const INTERACTIONS_CSV_HEADER = [
  'timestamp_ist',
  'student_id',
  'referred_by_id',
  'geo_entity_type',
  'geo_entity_name',
  'level',
  'lesson_type',
  'content',
  'correct_answer',
  'sarvam_transcript',
  'azure_transcript',
  'reverie_transcript',
  'bodhan_transcript',
  'audio_duration_ms',
  'answer_status',
  'score_change',
  'letters_touched',
  'starting_state',
  'final_state',
  'state_transition_id',
  'passage_id',
  'user_message_id',
  'lesson_state_id',
] as const;

/**
 * Escapes one cell: RFC-4180 quoting, plus spreadsheet formula-injection
 * hardening — a leading =, +, - or @ would otherwise execute as a formula
 * when the CSV is opened in Excel/Sheets (transcripts are attacker-
 * influenced text), so such cells get a leading apostrophe. This
 * also prefixes legitimately negative numbers (score_change -0.5 → '-0.5):
 * accepted cost of the mitigation.
 */
export function csvEscape(cell: string): string {
  const hardened = /^[=+\-@]/.test(cell) ? `'${cell}` : cell;
  return /[",\r\n]/.test(hardened)
    ? `"${hardened.replace(/"/g, '""')}"`
    : hardened;
}

function answerStatus(answerCorrect: boolean | null): string {
  if (answerCorrect === null) return '';
  return answerCorrect ? 'correct' : 'incorrect';
}

/** Serializes one row in INTERACTIONS_CSV_HEADER order, CRLF-terminated. */
export function interactionRowToCsvLine(row: InteractionRow): string {
  const cells: (string | number | null)[] = [
    row.timestamp_ist,
    row.student_id,
    row.referred_by_id,
    row.geo_entity_type,
    row.geo_entity_name,
    row.level,
    row.lesson_type,
    row.content,
    row.correct_answer,
    row.sarvam_transcript,
    row.azure_transcript,
    row.reverie_transcript,
    row.bodhan_transcript,
    row.audio_duration_ms,
    answerStatus(row.answer_correct),
    row.score_change === null
      ? ''
      : String(Math.round(parseFloat(row.score_change) * 100) / 100),
    row.letters_touched,
    row.starting_state,
    row.final_state,
    row.state_transition_id,
    row.passage_id,
    row.user_message_id,
    row.lesson_state_id,
  ];
  return (
    cells.map((c) => csvEscape(c === null ? '' : String(c))).join(',') + CSV_EOL
  );
}

export function interactionsCsvHeaderLine(): string {
  return CSV_BOM + INTERACTIONS_CSV_HEADER.join(',') + CSV_EOL;
}

/** Present ⇒ the export finished; absent ⇒ truncated mid-stream. */
export function interactionsCsvFooterLine(totalRows: number): string {
  return `# export complete, ${totalRows} rows${CSV_EOL}`;
}
