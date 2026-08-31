import {
  CSV_BOM,
  CSV_EOL,
  INTERACTIONS_BATCH_SIZE,
  INTERACTIONS_CSV_HEADER,
  InteractionRow,
  csvEscape,
  interactionRowToCsvLine,
  interactionsCsvFooterLine,
  interactionsCsvHeaderLine,
} from './interactions-csv';

function row(over: Partial<InteractionRow> = {}): InteractionRow {
  return {
    lesson_state_id: 'lls-1',
    created_at: new Date('2026-08-31T05:00:00Z'),
    timestamp_ist: '2026-08-31 10:30:00',
    student_name: 'अमन',
    phone: '919876543210',
    referred_by_name: null,
    referred_by_phone: null,
    level: 8,
    lesson_type: 'passage',
    content: 'क्या तुम इसे पढ़ सकते हो?',
    correct_answer: 'क्या तुम इसे पढ़ सकते हो?',
    answer_correct: true,
    sarvam_transcript: 'क्या तुम इसे पढ़ सकते हो',
    azure_transcript: null,
    reverie_transcript: null,
    score_change: '1.5',
    letters_touched: '12',
    starting_state: 'sentence',
    final_state: 'complete',
    state_transition_id: 'p1-sentence-complete-correct-first',
    passage_id: 'p1',
    user_message_id: 'mm-1',
    ...over,
  };
}

describe('csvEscape', () => {
  it('leaves plain cells (Hindi included) untouched', () => {
    expect(csvEscape('क्या तुम')).toBe('क्या तुम');
  });

  it.each([
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\nbreak', '"line\nbreak"'],
    ['cr\rbreak', '"cr\rbreak"'],
  ])('quotes %j', (input, expected) => {
    expect(csvEscape(input)).toBe(expected);
  });
});

describe('interactionsCsvHeaderLine', () => {
  it('starts with the UTF-8 BOM and ends with CRLF', () => {
    const line = interactionsCsvHeaderLine();
    expect(line.startsWith(CSV_BOM)).toBe(true);
    expect(line.endsWith(CSV_EOL)).toBe(true);
    expect(line).toContain('timestamp_ist,student_name,phone');
  });
});

describe('interactionRowToCsvLine', () => {
  it('serializes every header column in order, CRLF-terminated', () => {
    const line = interactionRowToCsvLine(row());
    expect(line.endsWith(CSV_EOL)).toBe(true);
    const cells = line.slice(0, -CSV_EOL.length).split(',');
    expect(cells).toHaveLength(INTERACTIONS_CSV_HEADER.length);
    expect(cells[0]).toBe('2026-08-31 10:30:00');
    expect(cells[INTERACTIONS_CSV_HEADER.indexOf('answer_status')]).toBe(
      'correct',
    );
    expect(cells[INTERACTIONS_CSV_HEADER.indexOf('lesson_state_id')]).toBe(
      'lls-1',
    );
  });

  it('nulls become empty cells; answer_correct null → blank status', () => {
    const line = interactionRowToCsvLine(
      row({
        student_name: null,
        answer_correct: null,
        score_change: null,
        starting_state: null,
      }),
    );
    const cells = line.slice(0, -CSV_EOL.length).split(',');
    expect(cells[INTERACTIONS_CSV_HEADER.indexOf('student_name')]).toBe('');
    expect(cells[INTERACTIONS_CSV_HEADER.indexOf('answer_status')]).toBe('');
    expect(cells[INTERACTIONS_CSV_HEADER.indexOf('score_change')]).toBe('');
  });

  it('answer_correct false → incorrect; score rounded to 2 decimals', () => {
    const line = interactionRowToCsvLine(
      row({ answer_correct: false, score_change: '0.333333' }),
    );
    expect(line).toContain('incorrect');
    expect(line).toContain('0.33');
  });

  it('cells containing commas/quotes survive a naive split-count check', () => {
    const line = interactionRowToCsvLine(
      row({ content: 'एक, दो "तीन"', correct_answer: null }),
    );
    expect(line).toContain('"एक, दो ""तीन"""');
  });
});

describe('interactionsCsvFooterLine', () => {
  it('marks a complete export with the row total', () => {
    expect(interactionsCsvFooterLine(1234)).toBe(
      `# export complete, 1234 rows${CSV_EOL}`,
    );
  });
});

describe('INTERACTIONS_BATCH_SIZE', () => {
  it('is a sane page size', () => {
    expect(INTERACTIONS_BATCH_SIZE).toBeGreaterThanOrEqual(1000);
    expect(INTERACTIONS_BATCH_SIZE).toBeLessThanOrEqual(10000);
  });
});

// Formula-injection hardening: Excel/Sheets execute cells that start with
// these characters, and names/transcripts are attacker-influenced text.
describe('csvEscape — formula-injection hardening', () => {
  it.each([
    ['=1+2', "'=1+2"],
    ['+919876', "'+919876"],
    ['-0.5', "'-0.5"],
    ['@SUM(A1)', "'@SUM(A1)"],
  ])('neutralizes leading formula char in %j', (input, expected) => {
    expect(csvEscape(input)).toBe(expected);
  });

  it('hardens before quoting so both protections compose', () => {
    expect(csvEscape('=cmd,x')).toBe('"\'=cmd,x"');
  });

  it('does not touch mid-cell formula characters', () => {
    expect(csvEscape('a=b+c')).toBe('a=b+c');
  });

  it('a negative score_change row cell carries the apostrophe prefix', () => {
    const line = interactionRowToCsvLine(
      // reuse the fixture from above via a minimal inline row
      {
        lesson_state_id: 'l',
        created_at: new Date('2026-08-31T05:00:00Z'),
        timestamp_ist: '2026-08-31 10:30:00',
        student_name: null,
        phone: 'p',
        referred_by_name: null,
        referred_by_phone: null,
        level: null,
        lesson_type: 'word',
        content: null,
        correct_answer: null,
        answer_correct: null,
        sarvam_transcript: null,
        azure_transcript: null,
        reverie_transcript: null,
        score_change: '-0.5',
        letters_touched: null,
        starting_state: null,
        final_state: null,
        state_transition_id: null,
        passage_id: null,
        user_message_id: 'm',
      },
    );
    expect(line).toContain("'-0.5");
  });
});
