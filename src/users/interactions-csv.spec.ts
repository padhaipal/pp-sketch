import {
  CSV_BOM,
  CSV_EOL,
  INTERACTIONS_BATCH_SIZE,
  INTERACTIONS_CSV_HEADER,
  InteractionRow,
  InteractionSourceRow,
  anonymiseInteractionRow,
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
    student_id: 'u-student',
    referred_by_id: 'u-teacher',
    geo_entity_type: 'school',
    geo_entity_name: 'PS Kupwara',
    level: 8,
    lesson_type: 'passage',
    content: 'क्या तुम इसे पढ़ सकते हो?',
    correct_answer: 'क्या तुम इसे पढ़ सकते हो?',
    answer_correct: true,
    sarvam_transcript: 'क्या तुम इसे पढ़ सकते हो',
    azure_transcript: null,
    reverie_transcript: null,
    bodhan_transcript: null,
    audio_duration_ms: 5230,
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
    expect(line).toContain(
      'timestamp_ist,student_id,referred_by_id,geo_entity_type,geo_entity_name',
    );
    expect(line).not.toMatch(/student_name|referred_by_name|phone/);
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
    expect(cells[INTERACTIONS_CSV_HEADER.indexOf('audio_duration_ms')]).toBe(
      '5230',
    );
  });

  it('audio_duration_ms null (flow tap / pre-capture row) → blank cell', () => {
    const line = interactionRowToCsvLine(row({ audio_duration_ms: null }));
    const cells = line.slice(0, -CSV_EOL.length).split(',');
    expect(cells[INTERACTIONS_CSV_HEADER.indexOf('audio_duration_ms')]).toBe(
      '',
    );
  });

  it('nulls become empty cells; answer_correct null → blank status', () => {
    const line = interactionRowToCsvLine(
      row({
        referred_by_id: null,
        answer_correct: null,
        score_change: null,
        starting_state: null,
      }),
    );
    const cells = line.slice(0, -CSV_EOL.length).split(',');
    expect(cells[INTERACTIONS_CSV_HEADER.indexOf('referred_by_id')]).toBe('');
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

// The export must never carry a name or phone number: ids only, and the
// transcripts get the same censor pass as users/:id/media.
describe('anonymiseInteractionRow', () => {
  function src(over: Partial<InteractionSourceRow> = {}): InteractionSourceRow {
    return {
      ...row(),
      student_name: 'Rani Devi',
      referred_by_name: 'Asha Kumari',
      ...over,
    };
  }

  it('drops the student and teacher names', () => {
    const out = anonymiseInteractionRow(src()) as unknown as Record<
      string,
      unknown
    >;
    expect(out).not.toHaveProperty('student_name');
    expect(out).not.toHaveProperty('referred_by_name');
    expect(out.student_id).toBe('u-student');
    expect(out.referred_by_id).toBe('u-teacher');
    expect(out.geo_entity_name).toBe('PS Kupwara');
  });

  it('censors both known names, spoken phone numbers and "mera naam" out of every transcript', () => {
    const out = anonymiseInteractionRow(
      src({
        sarvam_transcript: 'Rani Devi ne padha',
        azure_transcript: 'Asha Kumari madam',
        reverie_transcript: 'mera number 98765 43210 hai',
        bodhan_transcript: 'mera naam Sunita hai',
      }),
    );
    expect(out.sarvam_transcript).toBe('[removed] ne padha');
    expect(out.azure_transcript).toBe('[removed] madam');
    expect(out.reverie_transcript).toBe('mera number [removed] hai');
    expect(out.bodhan_transcript).toBe('mera naam [removed] hai');
  });

  it('leaves null transcripts and null names alone', () => {
    const out = anonymiseInteractionRow(
      src({
        student_name: null,
        referred_by_name: null,
        sarvam_transcript: 'कमल',
        azure_transcript: null,
      }),
    );
    expect(out.sarvam_transcript).toBe('कमल');
    expect(out.azure_transcript).toBeNull();
  });

  it('serialized line never contains the names', () => {
    const line = interactionRowToCsvLine(
      anonymiseInteractionRow(
        src({ sarvam_transcript: 'Rani Devi bolti hai' }),
      ),
    );
    expect(line).not.toContain('Rani');
    expect(line).not.toContain('Asha');
    expect(line).toContain('u-student,u-teacher,school,PS Kupwara');
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
        student_id: 'u',
        referred_by_id: null,
        geo_entity_type: null,
        geo_entity_name: null,
        level: null,
        lesson_type: 'word',
        content: null,
        correct_answer: null,
        answer_correct: null,
        sarvam_transcript: null,
        azure_transcript: null,
        reverie_transcript: null,
        bodhan_transcript: null,
        audio_duration_ms: null,
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
