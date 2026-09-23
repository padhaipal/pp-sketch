import { CSV_BOM, CSV_EOL } from '../users/interactions-csv';
import {
  PASSAGES_CSV_HEADER,
  passagesCsv,
  PassageQuestionExportRow,
} from './passages-csv';

const ROW: PassageQuestionExportRow = {
  passage_id: 'p1',
  level: 10,
  passage_type: 'narrative',
  status: 'active',
  gate_failure: null,
  quality_verdict: 'pass',
  model: 'gpt-x',
  passage_created_at: new Date('2026-09-01T00:00:00Z'),
  passage_text: 'राम, "घर" गया\nदूसरी पंक्ति',
  question_id: 'q1',
  question_type: 'R1.1',
  question_text: 'राम कहाँ गया?',
  options: [
    { text: 'घर', correct: true, explanation: 'सही' },
    { text: 'स्कूल', correct: false, explanation: null },
  ],
};

describe('passagesCsv', () => {
  it('starts with a BOM and the header, one line per question', () => {
    const csv = passagesCsv([ROW]);
    const lines = csv.split(CSV_EOL);
    expect(lines[0]).toBe(CSV_BOM + PASSAGES_CSV_HEADER.join(','));
    expect(lines).toHaveLength(3); // header, row, trailing EOL
    expect(lines[2]).toBe('');
  });

  it('quotes commas, quotes and newlines; letters options; blanks missing cells', () => {
    const line = passagesCsv([ROW]).split(CSV_EOL)[1];
    expect(line).toContain('"राम, ""घर"" गया\nदूसरी पंक्ति"');
    // option_a, option_b, option_c (blank), option_d (blank), correct, explanations
    expect(line.endsWith(',घर,स्कूल,,,a,सही,,,')).toBe(true);
    expect(
      line.startsWith(
        'p1,10,narrative,active,,pass,gpt-x,2026-09-01T00:00:00.000Z,',
      ),
    ).toBe(true);
  });

  it('joins several correct options and keeps a string timestamp as is', () => {
    const line = passagesCsv([
      {
        ...ROW,
        passage_created_at: '2026-09-02T00:00:00Z',
        gate_failure: 'judge: off topic',
        status: 'gate_failed',
        options: [
          { text: 'x', correct: true, explanation: null },
          { text: 'y', correct: true, explanation: null },
        ],
      },
    ]).split(CSV_EOL)[1];
    expect(line).toContain(',gate_failed,judge: off topic,');
    expect(line).toContain(',2026-09-02T00:00:00Z,');
    expect(line).toContain(',x,y,,,a;b,');
  });

  it('empty input is just the header', () => {
    expect(passagesCsv([])).toBe(
      CSV_BOM + PASSAGES_CSV_HEADER.join(',') + CSV_EOL,
    );
  });
});
