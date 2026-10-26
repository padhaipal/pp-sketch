import {
  applyAserTurn,
  ASER_BANKS,
  aserMilestoneForHours,
  type AserStage,
  type AserState,
  aserStartStage,
  chooseBank,
  excludedPassageWords,
  newAserState,
  recordAserAnswer,
  remainingBankItems,
  withItem,
} from './aser';

// Delivers the next item at the current stage and answers it.
function answer(state: AserState, correct: boolean, value?: string): AserState {
  const v =
    value ??
    remainingBankItems(state)[0] ??
    `passage-${state.stage}-${state.used[state.stage].length}`;
  return recordAserAnswer(
    withItem(state, { stage: state.stage, value: v }),
    correct,
  );
}
function answers(state: AserState, seq: boolean[]): AserState {
  return seq.reduce((s, c) => answer(s, c), state);
}
const fresh = (milestone = 0) => newAserState(1, milestone, 'A');
const stage = (s: AserState): AserStage | 'done' =>
  s.status === 'done' ? 'done' : s.stage;

describe('ASER banks', () => {
  it('no bank letter appears in its own bank’s words', () => {
    for (const bank of Object.values(ASER_BANKS)) {
      expect(bank.words).toHaveLength(10);
      expect(bank.letters).toHaveLength(10);
      for (const l of bank.letters) {
        expect(bank.words.filter((w) => w.includes(l))).toEqual([]);
      }
    }
  });

  const h = (run: number, bank: string, shown = true) => ({
    run,
    bank: bank as 'A',
    shown,
  });
  const pick = (history: ReturnType<typeof h>[], r: number) =>
    chooseBank(history, () => r);

  it('picks at random among banks not yet shown in the cycle', () => {
    expect(pick([], 0)).toBe('A');
    expect(pick([], 0.99)).toBe('E');
    const history = [h(1, 'C'), h(2, 'A')];
    expect(['B', 'D', 'E']).toContain(pick(history, 0));
    expect(pick(history, 0)).toBe('B');
    expect(pick(history, 0.99)).toBe('E');
  });

  it('a run that showed no bank items uses nothing up', () => {
    expect(pick([h(1, 'A'), h(2, 'B', false)], 0)).toBe('B');
  });

  it('every bank once before any repeats; never the same bank twice in a row across cycles', () => {
    const history = ['C', 'A', 'E', 'B', 'D'].map((b, i) => h(i + 1, b));
    for (const r of [0, 0.3, 0.6, 0.99]) {
      expect(pick(history, r)).not.toBe('D');
    }
    const full = [...history, h(6, 'B')];
    expect(['A', 'C', 'D', 'E']).toContain(pick(full, 0.5));
  });

  it('works over many simulated runs', () => {
    const history: ReturnType<typeof h>[] = [];
    for (let run = 1; run <= 20; run++) {
      history.push(h(run, chooseBank(history)));
    }
    for (let c = 0; c < 4; c++) {
      const cycle = history.slice(c * 5, c * 5 + 5).map((x) => x.bank);
      expect(new Set(cycle).size).toBe(5);
    }
    for (let i = 1; i < history.length; i++) {
      expect(history[i].bank).not.toBe(history[i - 1].bank);
    }
  });
});

describe('aserMilestoneForHours', () => {
  it('2 h, 5 h, 10 h, then every 5 h', () => {
    expect(aserMilestoneForHours(1.99)).toBeNull();
    expect(aserMilestoneForHours(2)).toBe(2);
    expect(aserMilestoneForHours(4.9)).toBe(2);
    expect(aserMilestoneForHours(5)).toBe(5);
    expect(aserMilestoneForHours(9.9)).toBe(5);
    expect(aserMilestoneForHours(10)).toBe(10);
    expect(aserMilestoneForHours(14.9)).toBe(10);
    expect(aserMilestoneForHours(15)).toBe(15);
    expect(aserMilestoneForHours(27)).toBe(25);
  });
});

describe('recordAserAnswer — routing', () => {
  it('starts at the word level', () => {
    expect(fresh().stage).toBe('word');
  });

  it('first two words wrong → letters; 4 letters right → back to words with the counts carried', () => {
    let s = answers(fresh(), [false, false]);
    expect(stage(s)).toBe('letter');
    expect(s.outcomes.word).toBeUndefined();
    s = answers(s, [true, false, true, true, true]);
    expect(s.outcomes.letter).toBe('passed');
    expect(stage(s)).toBe('word');
    expect(s.counts.word).toEqual({ correct: 0, incorrect: 2 });
    // no second fast jump: five more wrong words = 7 → fail, letters
    // already passed → the test ends
    s = answers(s, [false, false, false, false, false]);
    expect(s.outcomes.word).toBe('failed');
    expect(s.status).toBe('done');
    expect(s.result).toBe('letter');
    expect(s.placementLevel).toBe(2);
  });

  it('seven wrong letters ends the test at beginner (placement 1)', () => {
    let s = answers(fresh(), [false, false]);
    s = answers(s, [
      false,
      true,
      false,
      false,
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(s.outcomes.letter).toBe('failed');
    expect(s.status).toBe('done');
    expect(s.result).toBe('beginner');
    expect(s.placementLevel).toBe(1);
  });

  it('first two words right → paragraph; first paragraph right → story; story ends the test', () => {
    let s = answers(fresh(), [true, true]);
    expect(stage(s)).toBe('paragraph');
    s = answer(s, true);
    expect(s.outcomes.paragraph).toBe('passed');
    expect(stage(s)).toBe('story');
    s = answer(s, false);
    expect(s.status).toBe('done');
    expect(s.result).toBe('paragraph');
    expect(s.placementLevel).toBe(9);
  });

  it('second paragraph right is enough; story passed → story (placement 10)', () => {
    let s = answers(fresh(), [true, true]);
    s = answers(s, [false, true]);
    expect(s.outcomes.paragraph).toBe('passed');
    s = answer(s, true);
    expect(s.result).toBe('story');
    expect(s.placementLevel).toBe(10);
  });

  it('both paragraphs wrong before words are passed → back to words; 4 right then ends (paragraph already failed)', () => {
    let s = answers(fresh(), [true, true]);
    s = answers(s, [false, false]);
    expect(s.outcomes.paragraph).toBe('failed');
    expect(stage(s)).toBe('word');
    expect(s.counts.word).toEqual({ correct: 2, incorrect: 0 });
    s = answers(s, [false, true, true]);
    expect(s.outcomes.word).toBe('passed');
    expect(s.status).toBe('done');
    expect(s.result).toBe('word');
    expect(s.placementLevel).toBe(3);
  });

  it('paragraphs failed after words were passed → test over', () => {
    let s = answers(fresh(), [true, false, true, true, true]);
    expect(s.outcomes.word).toBe('passed');
    expect(stage(s)).toBe('paragraph');
    s = answers(s, [false, false]);
    expect(s.status).toBe('done');
    expect(s.result).toBe('word');
  });

  it('mixed first two words stay at words until 4 right (→ paragraph) or 7 wrong (→ letters)', () => {
    let s = answers(fresh(), [true, false]);
    expect(stage(s)).toBe('word');
    s = answers(s, [false, true, false, true]);
    expect(s.outcomes.word).toBeUndefined();
    s = answer(s, true);
    expect(s.outcomes.word).toBe('passed');
    expect(stage(s)).toBe('paragraph');

    let t = answers(fresh(), [false, true]);
    t = answers(t, [false, false, false, false, false, false]);
    expect(t.outcomes.word).toBe('failed');
    expect(stage(t)).toBe('letter');
    // letters passed after words failed → nothing higher left → done
    t = answers(t, [true, true, true, true]);
    expect(t.status).toBe('done');
    expect(t.result).toBe('letter');
  });

  it('retests carry no placement', () => {
    const s = answers(newAserState(2, 5, 'B'), [true, true, true, true]);
    expect(s.status).toBe('done');
    expect(s.placementLevel).toBeNull();
  });

  it('only the FIRST answer to an item counts', () => {
    let s = withItem(fresh(), { stage: 'word', value: 'जय' });
    s = recordAserAnswer(s, false);
    s = recordAserAnswer(s, true);
    expect(s.counts.word).toEqual({ correct: 0, incorrect: 1 });
  });
});

describe('retests', () => {
  it('start at the ASER level of the pre-test lesson level; onboarding always at words', () => {
    expect(aserStartStage(0, 10)).toBe('word');
    expect(aserStartStage(2, null)).toBe('word');
    expect(aserStartStage(2, 2)).toBe('word');
    expect(aserStartStage(2, 8)).toBe('word');
    expect(aserStartStage(5, 9)).toBe('paragraph');
    expect(aserStartStage(5, 10)).toBe('story');
    expect(aserStartStage(5, 12)).toBe('story');
  });

  it('from paragraph: both wrong → words with NO fast jump on the first two', () => {
    let s = newAserState(2, 2, 'B', 'paragraph');
    expect(s.stage).toBe('paragraph');
    s = answers(s, [false, false]);
    expect(s.stage).toBe('word');
    s = answers(s, [false, false]);
    expect(s.stage).toBe('word'); // no drop to letters
    s = answers(s, [true, true]);
    expect(s.stage).toBe('word'); // no jump either
    s = answers(s, [true, true]);
    expect(s.outcomes.word).toBe('passed');
    expect(s.status).toBe('done'); // paragraph already failed
    expect(s.placementLevel).toBeNull();
  });

  it('from words (level 2–8) the fast jump applies', () => {
    const s = answers(newAserState(2, 2, 'B', 'word'), [true, true]);
    expect(s.stage).toBe('paragraph');
  });

  it('from story: pass ends it; fail drops to paragraph', () => {
    expect(answer(newAserState(3, 5, 'C', 'story'), true).result).toBe('story');
    const s = answer(newAserState(3, 5, 'C', 'story'), false);
    expect(s.status).toBe('in_progress');
    expect(s.stage).toBe('paragraph');
  });
});

const turn = (
  correct: boolean,
  stid: string,
  word: string,
  extra: Partial<Parameters<typeof applyAserTurn>[1]> = {},
): Parameters<typeof applyAserTurn>[1] => ({
  answerCorrect: correct,
  stateTransitionId: stid,
  word,
  machineState: 'word',
  askedLetter: null,
  lettersBefore: null,
  lettersAfter: null,
  ...extra,
});

describe('letter test turns (one lesson over the bank letters)', () => {
  const lt = (correct: number, incorrect: number, done = false) => ({
    correct,
    incorrect,
    done,
  });
  it('a change in the machine letter counts records the asked letter', () => {
    let s = answers(fresh(), [false, false]);
    expect(s.stage).toBe('letter');
    s = applyAserTurn(
      s,
      turn(false, 'ट-letter-routeWrongLetter-correct-more', 'कप', {
        machineState: 'letter',
        askedLetter: 'छ',
        lettersBefore: lt(0, 0),
        lettersAfter: lt(1, 0),
      }),
    );
    expect(s.counts.letter).toEqual({ correct: 1, incorrect: 0 });
    expect(s.used.letter).toEqual(['छ']);
    // a drill turn (image) with unchanged counts records nothing
    const same = applyAserTurn(
      s,
      turn(true, 'ट-image-letterImage-correct', 'कप', {
        machineState: 'letterImage',
        askedLetter: 'ट',
        lettersBefore: lt(1, 0),
        lettersAfter: lt(1, 0),
      }),
    );
    expect(same).toBe(s);
  });

  it('letters pass with words undecided → the word the loop returns to is the next word item', () => {
    let s = answers(fresh(), [false, false]);
    s = answers(s, [true, true, true]);
    s = applyAserTurn(
      s,
      turn(true, 'कप-letter-word-correct-last', 'कप', {
        machineState: 'word',
        askedLetter: 'घ',
        lettersBefore: lt(3, 0),
        lettersAfter: lt(4, 0, true),
      }),
    );
    expect(s.outcomes.letter).toBe('passed');
    expect(s.stage).toBe('word');
    expect(s.item).toEqual({ stage: 'word', value: 'कप' });
    expect(s.used.word).toContain('कप');
    // its first answer counts as a word answer
    s = applyAserTurn(s, turn(true, 'कप-word-complete-correct-first', 'कप'));
    expect(s.counts.word).toEqual({ correct: 1, incorrect: 2 });
  });
});

describe('passage word exclusion', () => {
  it('paragraphs exclude words drilled at the word level; the story also paragraph drills', () => {
    let s = withItem(fresh(), { stage: 'word', value: 'जय' });
    s = applyAserTurn(
      s,
      turn(false, 'ज-word-routeWrongLetter-drillLetters', 'जय'),
    );
    s = answers(s, [true, true, true, true]);
    expect(stage(s)).toBe('paragraph');
    expect([...excludedPassageWords(s)]).toEqual(['जय']);

    s = withItem(s, { stage: 'paragraph', value: 'p1' });
    s = applyAserTurn(s, turn(false, 'बादल-sentence-word-drillWord', 'बादल'));
    // a correct word answer is feedback but no drill: not excluded
    expect(s.wordDrills).toEqual(['जय']);
    expect(s.paragraphDrills).toEqual(['बादल']);
    expect([...excludedPassageWords(s)]).toEqual(['जय']);
    s = answer(s, true);
    expect(stage(s)).toBe('story');
    expect([...excludedPassageWords(s)].sort()).toEqual(['जय', 'बादल'].sort());
  });

  it('only the first answer to an item counts; later turns in the lesson count nothing', () => {
    let s = withItem(fresh(), { stage: 'word', value: 'जय' });
    s = applyAserTurn(
      s,
      turn(false, 'ज-word-routeWrongLetter-drillLetters', 'जय'),
    );
    const again = applyAserTurn(
      s,
      turn(true, 'जय-letter-word-correct-last', 'जय'),
    );
    expect(again).toBe(s);
  });
});
