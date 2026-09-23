// GET /media-meta-data/passages.csv — one line per question, the passage
// repeated on each. Pure: the controller feeds it the service's rows.
import { CSV_BOM, CSV_EOL, csvEscape } from '../users/interactions-csv';

export interface PassageQuestionExportRow {
  passage_id: string;
  level: number | null;
  passage_type: string | null;
  status: string;
  gate_failure: string | null;
  quality_verdict: string | null;
  model: string | null;
  passage_created_at: Date | string;
  passage_text: string;
  question_id: string;
  question_type: string | null;
  question_text: string;
  options: Array<{
    text: string;
    correct: boolean;
    explanation: string | null;
  }>;
}

const LETTERS = ['a', 'b', 'c', 'd'];

export const PASSAGES_CSV_HEADER = [
  'passage_id',
  'level',
  'passage_type',
  'status',
  'gate_failure',
  'quality_verdict',
  'model',
  'passage_created_at',
  'passage_text',
  'question_id',
  'question_type',
  'question_text',
  ...LETTERS.map((l) => `option_${l}`),
  'correct_option',
  ...LETTERS.map((l) => `explanation_${l}`),
];

function iso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}

export function passagesCsv(rows: PassageQuestionExportRow[]): string {
  const line = (cells: Array<string | number | null>): string =>
    cells.map((c) => csvEscape(c === null ? '' : String(c))).join(',') +
    CSV_EOL;
  let out = CSV_BOM + line(PASSAGES_CSV_HEADER);
  for (const r of rows) {
    const opt = (i: number) => r.options[i] ?? null;
    const correct = r.options
      .map((o, i) => (o.correct ? (LETTERS[i] ?? String(i + 1)) : ''))
      .filter(Boolean)
      .join(';');
    out += line([
      r.passage_id,
      r.level,
      r.passage_type,
      r.status,
      r.gate_failure,
      r.quality_verdict,
      r.model,
      iso(r.passage_created_at),
      r.passage_text,
      r.question_id,
      r.question_type,
      r.question_text,
      ...LETTERS.map((_, i) => opt(i)?.text ?? null),
      correct,
      ...LETTERS.map((_, i) => opt(i)?.explanation ?? null),
    ]);
  }
  return out;
}
