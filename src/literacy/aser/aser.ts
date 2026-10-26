// ASER (Hindi) reading-test proxy, delivered over WhatsApp — pure logic.
// See aser.prompt.md for the full rules. No I/O here: AserService does the
// DB reads, LiteracyLessonService persists the state inside each lesson
// snapshot (context.aser), so the lesson-state rows are the source of truth.
// No ASER-specific stids: every item uses the lesson loop's own.

// ─── Banks ───────────────────────────────────────────────────────────────────

// Five banks; a student sees every bank once before any repeats
// (chooseBank). No bank letter appears in its own
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

// One past run as chooseBank reads it (its latest row): the bank it drew
// and whether any of that bank's letters or words were actually shown.
export interface AserBankHistoryEntry {
  run: number;
  bank: AserBank;
  shown: boolean;
}

// Random bank among those not yet SHOWN in the current cycle. Walking the
// past runs in order, the cycle restarts once all five have been shown; a
// run that never reached the letter/word levels showed nothing and uses up
// nothing. At a cycle start the bank shown last is left out, so the same
// bank never comes twice in a row across the boundary. Derived from the
// runs' own state — no rotation record is stored.
export function chooseBank(
  history: readonly AserBankHistoryEntry[],
  random: () => number = Math.random,
): AserBank {
  let seen = new Set<AserBank>();
  let lastShown: AserBank | null = null;
  for (const h of [...history].sort((a, b) => a.run - b.run)) {
    if (!h.shown) continue;
    seen.add(h.bank);
    lastShown = h.bank;
    if (seen.size === ASER_BANK_ORDER.length) seen = new Set();
  }
  let options = ASER_BANK_ORDER.filter((b) => !seen.has(b));
  if (seen.size === 0 && lastShown) {
    options = options.filter((b) => b !== lastShown);
  }
  return options[Math.floor(random() * options.length)];
}

// ─── Rules ───────────────────────────────────────────────────────────────────

// Letter and word levels: pass on 4 right, fail on 7 wrong (≤ 10 items).
export const ASER_PASS_CORRECT = 4;
export const ASER_FAIL_INCORRECT = 7;
// A run that STARTS at words (the onboarding run, or a retest from lesson
// level 2–8): its first two word answers decide the fast jump (both right
// → paragraph, both wrong → letters). Never when words are reached later.
export const ASER_FAST_JUMP_ITEMS = 2;

// Letter / word level verdict from its counts; null = not decided yet.
export function aserCountVerdict(c: {
  correct: number;
  incorrect: number;
}): AserOutcome | null {
  if (c.correct >= ASER_PASS_CORRECT) return 'passed';
  if (c.incorrect >= ASER_FAIL_INCORRECT) return 'failed';
  return null;
}
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

// Where a run starts. The onboarding run always starts at words; a retest
// starts at the ASER level matching the student's pre-test lesson level:
// word lessons and level 8 → word, 9 → paragraph, 10+ → story.
export function aserStartStage(
  milestone: number,
  lessonLevel: number | null,
): AserStage {
  if (milestone === 0 || lessonLevel === null || lessonLevel <= 8) {
    return 'word';
  }
  return lessonLevel === ASER_PARAGRAPH_PASSAGE_LEVEL ? 'paragraph' : 'story';
}

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
  startStage: AserStage; // the level the run started at
  stage: AserStage; // level the next item is drawn from
  outcomes: Partial<Record<AserStage, AserOutcome>>;
  // Answers per level — four tests, each counted even when undecided.
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

export function newAserState(
  run: number,
  milestone: number,
  bank: AserBank,
  startStage: AserStage = 'word',
): AserState {
  const zero = () => ({ correct: 0, incorrect: 0 });
  return {
    run,
    milestone,
    bank,
    status: 'in_progress',
    startStage,
    stage: startStage,
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
    const verdict = aserCountVerdict(c);
    if (verdict) {
      s = { ...s, outcomes: { ...s.outcomes, [stage]: verdict } };
      return afterDecision(s, stage);
    }
    // Fast jump on the first two words of a run that started at words: a
    // likely level, not a decision.
    if (
      stage === 'word' &&
      s.startStage === 'word' &&
      c.correct + c.incorrect === ASER_FAST_JUMP_ITEMS
    ) {
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

  // story: one passage. A pass ends the test; a fail drops to paragraph
  // unless it is already decided (always, unless the run started at story).
  s = {
    ...s,
    outcomes: { ...s.outcomes, story: correct ? 'passed' : 'failed' },
  };
  return afterDecision(s, stage);
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

// The letter level runs as ONE lesson walking the bank letters through the
// lesson machine's letter loop (machine context.aserLetters counts each
// letter's first answer and ends the loop once decided). Its counts before
// and after a turn tell which letter was answered and how.
export interface AserLetterCounts {
  correct: number;
  incorrect: number;
  done: boolean;
}

// Applies one voice turn to the test state riding in the lesson snapshot.
// - Letter lesson: a change in the machine's letter counts is the asked
//   letter's first answer. When the letters pass with words undecided, the
//   lesson returns to `word` on the next ASER word (the machine's
//   `…-word-correct-last` style return) and that word becomes the item.
// - Otherwise the item's FIRST answer is counted (answerCorrect).
// - A drill word chosen during a paragraph read is kept out of the story.
export const SENTENCE_DRILL_WORD_STID_SUFFIX = '-sentence-word-drillWord';
export function applyAserTurn(
  state: AserState,
  turn: {
    answerCorrect: boolean | null;
    stateTransitionId: string;
    word: string;
    machineState: string;
    askedLetter: string | null; // wrongLetters[0] before the turn
    lettersBefore: AserLetterCounts | null;
    lettersAfter: AserLetterCounts | null;
  },
): AserState {
  let s = state;
  const before = turn.lettersBefore;
  const after = turn.lettersAfter;
  if (
    before &&
    after &&
    turn.askedLetter &&
    after.correct + after.incorrect > before.correct + before.incorrect
  ) {
    s = recordAserAnswer(
      withItem(s, { stage: 'letter', value: turn.askedLetter }),
      after.correct > before.correct,
    );
  } else if (s.item && !s.item.answered) {
    s = recordAserAnswer(s, turn.answerCorrect === true);
  }
  if (
    after?.done &&
    turn.machineState === 'word' &&
    s.status === 'in_progress' &&
    s.stage === 'word' &&
    s.item?.stage === 'letter'
  ) {
    s = withItem(s, { stage: 'word', value: turn.word });
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

// The four ASER tests, as stored (test_results_student.aser_lN_*).
export const ASER_TESTS = [
  ['aser_l1', 'letter'],
  ['aser_l2', 'word'],
  ['aser_l3', 'paragraph'],
  ['aser_l4', 'story'],
] as const;
export type AserTestKey = (typeof ASER_TESTS)[number][0];

// One test within one finished run: answers counted even when the test
// was left undecided (passed null). `at` = when the run ended (the answer
// that finished it).
export interface AserTestPoint {
  run: number;
  at: Date;
  correct: number;
  incorrect: number;
  passed: boolean | null;
}

// A student's runs of one test, like SnapshotTestScore: latest = the most
// recent finished run that reached the test; history = all of them, oldest
// first. 'insufficient_data' until one exists.
export interface AserTestScore {
  status: 'ok' | 'insufficient_data';
  runs_available: number;
  latest?: AserTestPoint;
  history?: AserTestPoint[];
}

// The rows aserTestScoresFromRows reads (user ids = $1), chronological.
export const ASER_ROWS_SQL = `/* aser:rows */
  SELECT user_id, created_at, snapshot->'context'->'aser' AS aser
  FROM literacy_lesson_states
  WHERE user_id = ANY($1::uuid[])
    AND snapshot->'context'->'aser'->>'run' IS NOT NULL
  ORDER BY user_id, created_at`;

// Folds one student's ASER rows (chronological) into the four tests. A run
// counts once finished: its final state, timestamped by its first 'done'
// row. Unfinished runs are ignored until they finish.
export function aserTestScoresFromRows(
  rows: ReadonlyArray<{ created_at: Date | string; aser: AserState }>,
): Record<AserTestKey, AserTestScore> {
  const finished = new Map<number, { at: Date; state: AserState }>();
  for (const { created_at, aser } of rows) {
    if (aser.status !== 'done') continue;
    const prev = finished.get(aser.run);
    finished.set(aser.run, {
      at: prev?.at ?? new Date(created_at),
      state: aser,
    });
  }
  const runs = [...finished.values()].sort((a, b) => a.state.run - b.state.run);
  const out = {} as Record<AserTestKey, AserTestScore>;
  for (const [key, stage] of ASER_TESTS) {
    const history: AserTestPoint[] = [];
    for (const { at, state } of runs) {
      const c = state.counts[stage];
      if (c.correct + c.incorrect === 0) continue;
      const outcome = state.outcomes[stage];
      history.push({
        run: state.run,
        at,
        correct: c.correct,
        incorrect: c.incorrect,
        passed: outcome === undefined ? null : outcome === 'passed',
      });
    }
    out[key] =
      history.length === 0
        ? { status: 'insufficient_data', runs_available: 0 }
        : {
            status: 'ok',
            runs_available: history.length,
            latest: history[history.length - 1],
            history,
          };
  }
  return out;
}

// Per user: the four tests (every requested id gets an entry).
export async function computeAserTestScores(
  query: (sql: string, params: unknown[]) => Promise<unknown>,
  userIds: string[],
): Promise<Map<string, Record<AserTestKey, AserTestScore>>> {
  const rows = (await query(ASER_ROWS_SQL, [userIds])) as Array<{
    user_id: string;
    created_at: Date | string;
    aser: AserState;
  }>;
  const byUser = new Map<string, typeof rows>(userIds.map((id) => [id, []]));
  for (const r of rows) byUser.get(r.user_id)?.push(r);
  return new Map(
    [...byUser].map(([id, list]) => [id, aserTestScoresFromRows(list)]),
  );
}
