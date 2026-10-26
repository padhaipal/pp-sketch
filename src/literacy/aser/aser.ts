// ASER (Hindi) reading-test proxy, delivered over WhatsApp — pure logic.
// See aser.prompt.md for the full rules. No I/O here: AserService does the
// DB reads, LiteracyLessonService persists the state inside each lesson
// snapshot (context.aser), so the lesson-state rows are the source of truth.

// ─── Banks ───────────────────────────────────────────────────────────────────

// Five banks, rotated per test run. No bank letter appears in its own
// bank's words, so the word-level letter drills never teach a letter the
// letter level then tests. Passages are NOT part of the banks.
export const ASER_BANKS = {
  A: {
    words: ['खुशी', 'जय', 'सेब', 'हाथ', 'दूध', 'कप', 'ऊन', 'तैर', 'आठ', 'मिल'],
    letters: ['छ', 'च', 'ऐ', 'व', 'घ', 'भ', 'ओ', 'ग', 'ट', 'ड'],
  },
  B: {
    words: ['घर', 'भेज', 'मन', 'बैठ', 'फूल', 'चोटी', 'ईख', 'दस', 'पिता', 'कौआ'],
    letters: ['ह', 'छ', 'अ', 'ड', 'ग', 'ध', 'इ', 'श', 'व', 'थ'],
  },
  C: {
    words: ['अभी', 'मेज', 'धूप', 'दिख', 'छत', 'फल', 'चुन', 'हवा', 'बस', 'और'],
    letters: ['ट', 'थ', 'ई', 'क', 'श', 'य', 'ऊ', 'घ', 'ठ', 'ग'],
  },
  D: {
    words: ['दिन', 'पौधा', 'आग', 'सब', 'शुभ', 'एक', 'रोटी', 'खेत', 'चल', 'घूम'],
    letters: ['छ', 'य', 'ऊ', 'ज', 'ठ', 'ड', 'ओ', 'थ', 'फ', 'ह'],
  },
  E: {
    words: ['आज', 'डूब', 'रुक', 'छिप', 'सच', 'भाई', 'देख', 'हम', 'ढोल', 'तीन'],
    letters: ['ट', 'घ', 'ओ', 'ध', 'य', 'थ', 'औ', 'फ', 'ठ', 'व'],
  },
} as const;
export type AserBank = keyof typeof ASER_BANKS;
export const ASER_BANK_ORDER: AserBank[] = ['A', 'B', 'C', 'D', 'E'];

// Run n (1-based) uses bank A, B, C, D, E, A, … — the sixth run repeats.
export function bankForRun(run: number): AserBank {
  return ASER_BANK_ORDER[(Math.max(run, 1) - 1) % ASER_BANK_ORDER.length];
}

// ─── Rules ───────────────────────────────────────────────────────────────────

// Letter and word levels: pass on 4 right, fail on 7 wrong (≤ 10 items).
export const ASER_PASS_CORRECT = 4;
export const ASER_FAIL_INCORRECT = 7;
// Both levels start the test at words; the first two word answers decide
// the fast jump (both right → paragraph, both wrong → letters).
export const ASER_FAST_JUMP_ITEMS = 2;
// Paragraph level: two passages, pass on either. Story level: one passage.
export const ASER_PARAGRAPH_ATTEMPTS = 2;
// LIFTeracy passage levels standing in for the ASER paragraph and story.
export const ASER_PARAGRAPH_PASSAGE_LEVEL = 9;
export const ASER_STORY_PASSAGE_LEVEL = 10;

// Test schedule (all-time active hours, users/active-time.ts rule):
// right after onboarding (milestone 0 — the student's first lesson ever),
// then after the lesson that reaches 2 h, 5 h, 10 h and every 5 h after.
export function aserMilestoneForHours(hours: number): number | null {
  if (hours >= 10) return Math.floor(hours / 5) * 5;
  if (hours >= 5) return 5;
  if (hours >= 2) return 2;
  return null;
}

// Fixed stids (not machine transitions; unseeded = nothing is sent). The
// service prepends START to the first item's prompt and appends COMPLETE on
// the turn that ends the test; the letter-level item endings replace the
// letter-drill → word returns (there is no word to go back to).
export const ASER_TEST_START_STATE_TRANSITION_ID = 'aser-test-start';
export const ASER_TEST_COMPLETE_STATE_TRANSITION_ID = 'aser-test-complete';
export const ASER_LETTER_COMPLETE_CORRECT_STATE_TRANSITION_ID =
  'aser-letter-complete-correct';
export const ASER_LETTER_COMPLETE_INCORRECT_STATE_TRANSITION_ID =
  'aser-letter-complete-incorrect';

// ─── State ───────────────────────────────────────────────────────────────────

export type AserStage = 'letter' | 'word' | 'paragraph' | 'story';
export const ASER_STAGES: AserStage[] = [
  'letter',
  'word',
  'paragraph',
  'story',
];
export type AserOutcome = 'passed' | 'failed';
// Highest level passed; 'beginner' = not even letters.
export type AserLevel = 'beginner' | AserStage;

export interface AserItem {
  stage: AserStage;
  // The letter / word itself, or the passage's media_metadata id.
  value: string;
  // Its first answer is in (the outcome counted). The lesson may go on —
  // drills, a retry, the comprehension question — but the next lesson
  // draws a new item; an unanswered item is delivered again (resume).
  answered?: boolean;
}

export interface AserState {
  run: number; // 1-based test number for this student
  milestone: number; // active hours that triggered it (0 = onboarding)
  bank: AserBank;
  status: 'in_progress' | 'done';
  stage: AserStage; // level the next item is drawn from
  outcomes: Partial<Record<AserStage, AserOutcome>>;
  // Answers so far per level (letter / word: counts; paragraph: attempts).
  counts: Record<AserStage, { correct: number; incorrect: number }>;
  used: Record<AserStage, string[]>; // items already delivered, per level
  // The item of the current / latest ASER lesson. Its outcome is its FIRST
  // answer; once counted the state advances (answered = true).
  item: AserItem | null;
  // Words drilled at the word level (answered wrong) — kept out of both
  // passages — and drill words from paragraph reads (kept out of the story).
  wordDrills: string[];
  paragraphDrills: string[];
  result: AserLevel | null; // set when done
  // Set when done on the onboarding test: the LIFTeracy level to start at.
  placementLevel: number | null;
}

export function newAserState(run: number, milestone: number): AserState {
  const zero = () => ({ correct: 0, incorrect: 0 });
  return {
    run,
    milestone,
    bank: bankForRun(run),
    status: 'in_progress',
    stage: 'word',
    outcomes: {},
    counts: { letter: zero(), word: zero(), paragraph: zero(), story: zero() },
    used: { letter: [], word: [], paragraph: [], story: [] },
    item: null,
    wordDrills: [],
    paragraphDrills: [],
    result: null,
    placementLevel: null,
  };
}

// Highest passed level. Passing a level implies the ones below it (a student
// fast-jumped past letters never sits them).
export function aserLevel(outcomes: AserState['outcomes']): AserLevel {
  for (let i = ASER_STAGES.length - 1; i >= 0; i--) {
    if (outcomes[ASER_STAGES[i]] === 'passed') return ASER_STAGES[i];
  }
  return 'beginner';
}

// LIFTeracy level the onboarding test places the student at. The lesson
// floor is word length 2 (literacy-lesson.service MIN_WORD_LENGTH_FLOOR), so
// "level 1" (failed letters) starts at 2 like failed words.
export const ASER_PLACEMENT_LEVEL: Record<AserLevel, number> = {
  beginner: 1,
  letter: 2,
  word: 3,
  paragraph: 9,
  story: 10,
};

// ─── Transitions ─────────────────────────────────────────────────────────────

const above = (s: AserStage): AserStage | null =>
  ASER_STAGES[ASER_STAGES.indexOf(s) + 1] ?? null;
const below = (s: AserStage): AserStage | null =>
  ASER_STAGES[ASER_STAGES.indexOf(s) - 1] ?? null;

function finish(state: AserState): AserState {
  const result = aserLevel(state.outcomes);
  return {
    ...state,
    status: 'done',
    result,
    placementLevel: state.milestone === 0 ? ASER_PLACEMENT_LEVEL[result] : null,
  };
}

// Where to go once `stage` is decided. Passing moves only up (stopping at a
// level already failed), failing moves only down (stopping at a level
// already passed) — so the test always ends.
function afterDecision(state: AserState, stage: AserStage): AserState {
  const next = state.outcomes[stage] === 'passed' ? above(stage) : below(stage);
  if (next === null || state.outcomes[next] !== undefined) return finish(state);
  return { ...state, stage: next };
}

// Records the FIRST answer to the item in flight and advances the test.
export function recordAserAnswer(
  state: AserState,
  correct: boolean,
): AserState {
  if (state.status === 'done' || !state.item || state.item.answered) {
    return state;
  }
  const stage = state.item.stage;
  const prev = state.counts[stage];
  const counts = {
    ...state.counts,
    [stage]: {
      correct: prev.correct + (correct ? 1 : 0),
      incorrect: prev.incorrect + (correct ? 0 : 1),
    },
  };
  let s: AserState = {
    ...state,
    counts,
    item: { ...state.item, answered: true },
    wordDrills:
      stage === 'word' && !correct
        ? [...state.wordDrills, state.item.value]
        : state.wordDrills,
  };
  const c = counts[stage];

  if (stage === 'letter' || stage === 'word') {
    if (c.correct >= ASER_PASS_CORRECT) {
      s = { ...s, outcomes: { ...s.outcomes, [stage]: 'passed' } };
      return afterDecision(s, stage);
    }
    if (c.incorrect >= ASER_FAIL_INCORRECT) {
      s = { ...s, outcomes: { ...s.outcomes, [stage]: 'failed' } };
      return afterDecision(s, stage);
    }
    // Fast jump on the first two words: a likely level, not a decision.
    if (stage === 'word' && c.correct + c.incorrect === ASER_FAST_JUMP_ITEMS) {
      if (c.correct === ASER_FAST_JUMP_ITEMS && !s.outcomes.paragraph) {
        return { ...s, stage: 'paragraph' };
      }
      if (c.incorrect === ASER_FAST_JUMP_ITEMS && !s.outcomes.letter) {
        return { ...s, stage: 'letter' };
      }
    }
    return s;
  }

  if (stage === 'paragraph') {
    if (correct) {
      s = { ...s, outcomes: { ...s.outcomes, paragraph: 'passed' } };
      return afterDecision(s, stage);
    }
    if (c.incorrect >= ASER_PARAGRAPH_ATTEMPTS) {
      s = { ...s, outcomes: { ...s.outcomes, paragraph: 'failed' } };
      return afterDecision(s, stage);
    }
    return s;
  }

  // story: one passage, either way the test ends
  return finish({
    ...s,
    outcomes: { ...s.outcomes, story: correct ? 'passed' : 'failed' },
  });
}

// Records a drill word from a paragraph read (kept out of the story).
export function recordParagraphDrill(
  state: AserState,
  word: string,
): AserState {
  return state.paragraphDrills.includes(word)
    ? state
    : { ...state, paragraphDrills: [...state.paragraphDrills, word] };
}

// Ends the test early (no passage left to deliver) with what is known.
export function abandonAser(state: AserState): AserState {
  return finish(state);
}

// Bank items not yet delivered at `stage` (letter / word levels).
export function remainingBankItems(state: AserState): string[] {
  const bank = ASER_BANKS[state.bank];
  if (state.stage === 'letter') {
    return bank.letters.filter((l) => !state.used.letter.includes(l));
  }
  if (state.stage === 'word') {
    return bank.words.filter((w) => !state.used.word.includes(w));
  }
  return [];
}

// Words a passage at the current stage must not contain.
export function excludedPassageWords(state: AserState): Set<string> {
  return new Set(
    state.stage === 'story'
      ? [...state.wordDrills, ...state.paragraphDrills]
      : state.wordDrills,
  );
}

export function withItem(state: AserState, item: AserItem): AserState {
  return {
    ...state,
    item,
    used: {
      ...state.used,
      [item.stage]: [...state.used[item.stage], item.value],
    },
  };
}

// Applies one lesson turn to the test state riding in its snapshot: the
// item's FIRST answer is counted, and a drill word chosen during a
// paragraph read is recorded (kept out of the story). `answerTurn` is false
// for the lesson's opening row and for comprehension taps.
export const SENTENCE_DRILL_WORD_STID_SUFFIX = '-sentence-word-drillWord';
export function applyAserTurn(
  state: AserState,
  turn: {
    answerTurn: boolean;
    answerCorrect: boolean | null;
    stateTransitionId: string;
    word: string;
  },
): AserState {
  let s = state;
  if (turn.answerTurn && s.item && !s.item.answered) {
    s = recordAserAnswer(s, turn.answerCorrect === true);
  }
  if (
    s.item?.stage === 'paragraph' &&
    turn.stateTransitionId.endsWith(SENTENCE_DRILL_WORD_STID_SUFFIX)
  ) {
    s = recordParagraphDrill(s, turn.word);
  }
  return s;
}

// ─── Results (read side) ─────────────────────────────────────────────────────

// One test run as reported (GET /users/:id/literacy-test-scores → aser).
export interface AserRunResult {
  run: number;
  milestone: number;
  bank: AserBank;
  status: AserState['status'];
  // Highest level passed; null while in progress.
  result: AserLevel | null;
  outcomes: AserState['outcomes'];
  placement_level: number | null;
  started_at: Date;
  // The row that recorded the last item's answer — when the last question
  // on the test was submitted. Null while in progress.
  completed_at: Date | null;
}

// Folds a student's ASER lesson rows (chronological) into one result per
// run: the run's latest state; completed_at from its first 'done' row.
export function aserRunsFromRows(
  rows: ReadonlyArray<{ created_at: Date; aser: AserState }>,
): AserRunResult[] {
  const byRun = new Map<number, AserRunResult>();
  for (const { created_at, aser } of rows) {
    const prev = byRun.get(aser.run);
    byRun.set(aser.run, {
      run: aser.run,
      milestone: aser.milestone,
      bank: aser.bank,
      status: aser.status,
      result: aser.result,
      outcomes: aser.outcomes,
      placement_level: aser.placementLevel,
      started_at: prev?.started_at ?? created_at,
      completed_at:
        prev?.completed_at ?? (aser.status === 'done' ? created_at : null),
    });
  }
  return [...byRun.values()].sort((a, b) => a.run - b.run);
}

// The rows aserRunsFromRows reads (user id = $1).
export const ASER_ROWS_SQL = `SELECT created_at, snapshot->'context'->'aser' AS aser
  FROM literacy_lesson_states
  WHERE user_id = $1
    AND snapshot->'context'->'aser'->>'run' IS NOT NULL
  ORDER BY created_at`;
