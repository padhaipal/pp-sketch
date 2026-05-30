// The machine's transitions are guarded by markWord / markLetter / markImage /
// detectIncorrectEndMatra / detectIncorrectMiddleMatra / detectInsertion from
// evaluate-answer.utils. Mocking these lets each test pin down EXACTLY one
// branch by toggling which guard returns true.

const mockMarkWord = jest.fn();
const mockMarkLetter = jest.fn();
const mockMarkImage = jest.fn();
const mockDetectIncorrectEndMatra = jest.fn();
const mockDetectIncorrectMiddleMatra = jest.fn();
const mockDetectInsertion = jest.fn();
jest.mock('./evaluate-answer.utils', () => ({
  markWord: (...args: unknown[]) => mockMarkWord(...args),
  markLetter: (...args: unknown[]) => mockMarkLetter(...args),
  markImage: (...args: unknown[]) => mockMarkImage(...args),
  detectIncorrectEndMatra: (...args: unknown[]) =>
    mockDetectIncorrectEndMatra(...args),
  detectIncorrectMiddleMatra: (...args: unknown[]) =>
    mockDetectIncorrectMiddleMatra(...args),
  detectInsertion: (...args: unknown[]) => mockDetectInsertion(...args),
}));

// identifyCharacterStatus returns the list of wrong letters used to seed the
// machine's `wrongLetters` array on the first wrong-word transition. Control
// it directly per test.
const mockIdentifyCharacterStatus = jest.fn();
jest.mock('./identify-character-status.utils', () => ({
  identifyCharacterStatus: (...args: unknown[]) =>
    mockIdentifyCharacterStatus(...args),
}));

import { createActor } from 'xstate';
import { machine } from './literacy-lesson.machine';

type Snapshot = ReturnType<
  ReturnType<typeof createActor<typeof machine>>['getSnapshot']
>;

interface ActorHandle {
  send: (event: { type: 'ANSWER'; studentAnswer: string }) => void;
  snap: () => Snapshot;
  stop: () => void;
}

function makeActor(input: {
  word: string;
  userMessageId: string;
}): ActorHandle {
  const actor = createActor(machine, { input });
  actor.start();
  return {
    send: (event) => actor.send(event),
    snap: () => actor.getSnapshot(),
    stop: () => actor.stop(),
  };
}

function allMarksFalse(): void {
  mockMarkWord.mockReturnValue(false);
  mockMarkLetter.mockReturnValue(false);
  mockMarkImage.mockReturnValue(false);
  mockDetectIncorrectEndMatra.mockReturnValue(false);
  mockDetectIncorrectMiddleMatra.mockReturnValue(false);
  mockDetectInsertion.mockReturnValue(false);
}

beforeEach(() => {
  mockMarkWord.mockReset();
  mockMarkLetter.mockReset();
  mockMarkImage.mockReset();
  mockDetectIncorrectEndMatra.mockReset();
  mockDetectIncorrectMiddleMatra.mockReset();
  mockDetectInsertion.mockReset();
  mockIdentifyCharacterStatus.mockReset();
  allMarksFalse();
});

// ─── word state ──────────────────────────────────────────────────────────────

describe('machine — word state', () => {
  it('starts in `word` with the initial stateTransitionId derived from input.word', () => {
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    const snap = a.snap();
    expect(snap.value).toBe('word');
    expect(snap.context.stateTransitionId).toBe('कमल-start-word-initial');
    a.stop();
  });

  it('seeds the initial context (word entry sets answer=word, empties wrongLetters + pending)', () => {
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    const c = a.snap().context;
    expect(c.word).toBe('कमल');
    expect(c.answer).toBe('कमल'); // word-state entry assigns answer = word
    expect(c.answerCorrect).toBeNull();
    expect(c.userMessageId).toBe('mm-1');
    expect(c.wrongLetters).toEqual([]);
    expect(c.pendingCorrect).toEqual([]);
    expect(c.pendingIncorrect).toEqual([]);
    expect(c.wordErrors).toBe(0);
    expect(c.imageErrors).toBe(0);
    expect(c.letterErrors).toBe(0);
    expect(c.letterNoImageErrors).toBe(0);
    a.stop();
  });

  it('first-try correct word → complete + correct-first stid + pendingCorrect=Array(word)', () => {
    mockMarkWord.mockReturnValue(true);
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'कमल' });
    const snap = a.snap();
    expect(snap.value).toBe('complete');
    expect(snap.context.answerCorrect).toBe(true);
    expect(snap.context.stateTransitionId).toBe(
      'कमल-word-complete-correct-first',
    );
    expect(snap.context.pendingCorrect).toEqual(['क', 'म', 'ल']);
    expect(snap.status).toBe('done');
    a.stop();
  });

  it('subsequent-try correct word (wordErrors>0) → complete + correct-retry stid + no pendingCorrect', () => {
    // First answer: end-matra-error stays in `word` and increments wordErrors.
    mockDetectIncorrectEndMatra.mockReturnValue(true);
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'matra-typo' });
    expect(a.snap().value).toBe('word');
    expect(a.snap().context.wordErrors).toBe(1);

    // Second answer: word correct, but on retry (wordErrors>0).
    mockDetectIncorrectEndMatra.mockReturnValue(false);
    mockMarkWord.mockReturnValue(true);
    a.send({ type: 'ANSWER', studentAnswer: 'कमल' });

    const snap = a.snap();
    expect(snap.value).toBe('complete');
    expect(snap.context.stateTransitionId).toBe(
      'कमल-word-complete-correct-retry',
    );
    // No pendingCorrect on retry path
    expect(snap.context.pendingCorrect).toEqual([]);
    a.stop();
  });

  it('three wrong attempts at the word level → complete + maxErrors stid', () => {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: ['क', 'म', 'ल'],
    });
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'wrong-1' }); // routes to letter loop
    // After the first wrong word, we move out of `word` — coming back
    // requires the letter loop. Skip that here by re-entering word state
    // via the loopBack path: another wrong → wordErrors=2 → maxErrors.
    // But once in letter loop the only way back to `word` is via the letter
    // state correct-last transition. Simpler: drive `wordErrors` directly
    // is not possible; use the loopBack guard which fires on second wrong
    // word answer (i.e. AFTER a letter loop completion). This isn't worth
    // the setup — instead, test the maxErrors path by getting to `word`
    // with `wordErrors=2` via a longer sequence.
    //
    // Pragmatic: send a non-matra wrong answer from `word` first, the
    // letter loop drops one wrongLetter, then we get back to `word`.
    // From there a third wrong answer fires the >=2 maxErrors branch.

    // Simpler: directly drive wordErrors via the matra-on-first-try paths
    // that stay in `word` AND increment wordErrors.
    mockDetectIncorrectEndMatra.mockReturnValue(true);
    const b = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    b.send({ type: 'ANSWER', studentAnswer: 'wrong-end-matra' }); // wordErrors=1
    mockDetectIncorrectEndMatra.mockReturnValueOnce(false); // next answer is wrong but not matra
    b.send({ type: 'ANSWER', studentAnswer: 'wrong-end-matra' }); // wordErrors=2 (retry-matra)
    // 3rd attempt at word with wordErrors >= 2 → maxErrors
    mockMarkWord.mockReturnValue(false);
    mockDetectIncorrectEndMatra.mockReturnValue(false);
    b.send({ type: 'ANSWER', studentAnswer: 'totally-wrong' });

    const snap = b.snap();
    expect(snap.value).toBe('complete');
    expect(snap.context.stateTransitionId).toBe('कमल-word-complete-maxErrors');
    expect(snap.context.answerCorrect).toBe(false);

    a.stop();
    b.stop();
  });

  it('end-matra error on first try → stays in word, stid=endMatra-first, pendingCorrect=Array(word)', () => {
    mockDetectIncorrectEndMatra.mockReturnValue(true);
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'कमलि' });

    const snap = a.snap();
    expect(snap.value).toBe('word');
    expect(snap.context.stateTransitionId).toBe('कमल-word-word-endMatra-first');
    expect(snap.context.wordErrors).toBe(1);
    expect(snap.context.pendingCorrect).toEqual(['क', 'म', 'ल']);
    a.stop();
  });

  it('middle-matra error on first try → stays in word, stid=middleMatra-first', () => {
    mockDetectIncorrectMiddleMatra.mockReturnValue(true);
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'कमिल' });

    expect(a.snap().context.stateTransitionId).toBe(
      'कमल-word-word-middleMatra-first',
    );
    a.stop();
  });

  it('insertion error on first try → stays in word, stid=insertion-first', () => {
    mockDetectInsertion.mockReturnValue(true);
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'कमालिकल' });

    expect(a.snap().context.stateTransitionId).toBe(
      'कमल-word-word-insertion-first',
    );
    a.stop();
  });

  it('wrong word (no matra / insertion) → routes to letter loop and seeds wrongLetters', () => {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: ['क'],
      incorrectChars: ['म', 'ल'],
    });
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'totally-different' });

    const snap = a.snap();
    // routeWrongLetter is an always-transition → ends up in `letter` (none of
    // these letters are in NO_IMAGE_LETTERS)
    expect(snap.value).toBe('letter');
    expect(snap.context.wrongLetters).toEqual(['म', 'ल']);
    expect(snap.context.stateTransitionId).toBe(
      'म-word-routeWrongLetter-drillLetters',
    );
    a.stop();
  });
});

// ─── routeWrongLetter (always-transition) ──────────────────────────────────

describe('machine — routeWrongLetter routes to letterNoImage for special chars', () => {
  it('routes to letterNoImage when the first wrong letter is ञ or ण', () => {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: ['ञ', 'क'],
    });
    const a = makeActor({ word: 'word', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'wrong' });

    expect(a.snap().value).toBe('letterNoImage');
    a.stop();
  });

  it('routes to letter (with image) for any other wrong letter', () => {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: ['क'],
    });
    const a = makeActor({ word: 'word', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'wrong' });

    expect(a.snap().value).toBe('letter');
    a.stop();
  });
});

// ─── letter state ───────────────────────────────────────────────────────────

describe('machine — letter state', () => {
  function setupInLetter(wrongLetters: string[]): ActorHandle {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: wrongLetters,
    });
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'wrong-word' });
    return a;
  }

  it('correct + last wrongLetter → back to word, stid=letter-word-correct-last', () => {
    const a = setupInLetter(['म']);
    mockMarkLetter.mockReturnValue(true);
    a.send({ type: 'ANSWER', studentAnswer: 'म' });

    const snap = a.snap();
    expect(snap.value).toBe('word');
    expect(snap.context.stateTransitionId).toBe('कमल-letter-word-correct-last');
    expect(snap.context.pendingCorrect).toEqual(['म']);
    expect(snap.context.wrongLetters).toEqual([]);
    a.stop();
  });

  it('correct + more letters remaining → routeWrongLetter, stid=letter-routeWrongLetter-correct-more', () => {
    const a = setupInLetter(['म', 'ल']);
    mockMarkLetter.mockReturnValue(true);
    a.send({ type: 'ANSWER', studentAnswer: 'म' });

    const snap = a.snap();
    expect(snap.value).toBe('letter'); // routeWrongLetter → letter
    expect(snap.context.stateTransitionId).toBe(
      'ल-letter-routeWrongLetter-correct-more',
    );
    a.stop();
  });

  it('wrong letter → image, stid=letter-image-wrong, pendingIncorrect=[wrongLetter]', () => {
    const a = setupInLetter(['म']);
    mockMarkLetter.mockReturnValue(false);
    a.send({ type: 'ANSWER', studentAnswer: 'x' });

    const snap = a.snap();
    expect(snap.value).toBe('image');
    expect(snap.context.stateTransitionId).toBe('म-letter-image-wrong');
    expect(snap.context.pendingIncorrect).toEqual(['म']);
    a.stop();
  });
});

// ─── image state ───────────────────────────────────────────────────────────

describe('machine — image state', () => {
  function setupInImage(wrongLetters: string[]): ActorHandle {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: wrongLetters,
    });
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'wrong-word' });
    mockMarkLetter.mockReturnValue(false);
    a.send({ type: 'ANSWER', studentAnswer: 'x' }); // letter → image
    return a;
  }

  it('correct image → letterImage, stid=image-letterImage-correct', () => {
    const a = setupInImage(['म']);
    mockMarkImage.mockReturnValue(true);
    a.send({ type: 'ANSWER', studentAnswer: 'image-name' });

    const snap = a.snap();
    expect(snap.value).toBe('letterImage');
    expect(snap.context.stateTransitionId).toBe('म-image-letterImage-correct');
    a.stop();
  });

  it('image wrong on second attempt → letterImage, maxErrors stid, imageErrors reset to 0', () => {
    const a = setupInImage(['म']);
    mockMarkImage.mockReturnValue(false);
    a.send({ type: 'ANSWER', studentAnswer: 'x1' }); // 1st wrong, imageErrors=1, stays in image
    a.send({ type: 'ANSWER', studentAnswer: 'x2' }); // 2nd wrong, imageErrors>=1 → letterImage

    const snap = a.snap();
    expect(snap.value).toBe('letterImage');
    expect(snap.context.stateTransitionId).toBe(
      'म-image-letterImage-maxErrors',
    );
    expect(snap.context.imageErrors).toBe(0);
    a.stop();
  });

  it('image wrong on first attempt → stays in image, stid=image-image-wrong-first', () => {
    const a = setupInImage(['म']);
    mockMarkImage.mockReturnValue(false);
    a.send({ type: 'ANSWER', studentAnswer: 'x' });

    const snap = a.snap();
    expect(snap.value).toBe('image');
    expect(snap.context.stateTransitionId).toBe('म-image-image-wrong-first');
    expect(snap.context.imageErrors).toBe(1);
    a.stop();
  });
});

// ─── letterImage state ─────────────────────────────────────────────────────

describe('machine — letterImage state', () => {
  function setupInLetterImage(wrongLetters: string[]): ActorHandle {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: wrongLetters,
    });
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'wrong-word' });
    mockMarkLetter.mockReturnValue(false);
    a.send({ type: 'ANSWER', studentAnswer: 'x' }); // letter → image
    mockMarkImage.mockReturnValue(true);
    a.send({ type: 'ANSWER', studentAnswer: 'image-name' }); // image → letterImage
    return a;
  }

  it('correct + last wrongLetter → word, stid=letterImage-word-correct-last', () => {
    const a = setupInLetterImage(['म']);
    mockMarkLetter.mockReturnValue(true);
    a.send({ type: 'ANSWER', studentAnswer: 'म' });

    const snap = a.snap();
    expect(snap.value).toBe('word');
    expect(snap.context.stateTransitionId).toBe(
      'कमल-letterImage-word-correct-last',
    );
    expect(snap.context.wrongLetters).toEqual([]);
    a.stop();
  });

  it('correct + more letters → routeWrongLetter, stid=letterImage-routeWrongLetter-correct-more', () => {
    const a = setupInLetterImage(['म', 'ल']);
    mockMarkLetter.mockReturnValue(true);
    a.send({ type: 'ANSWER', studentAnswer: 'म' });

    const snap = a.snap();
    expect(snap.value).toBe('letter');
    expect(snap.context.stateTransitionId).toBe(
      'ल-letterImage-routeWrongLetter-correct-more',
    );
    a.stop();
  });

  it('wrong, first attempt → stays in letterImage, stid=wrong-first', () => {
    const a = setupInLetterImage(['म']);
    mockMarkLetter.mockReturnValue(false);
    a.send({ type: 'ANSWER', studentAnswer: 'x' });

    const snap = a.snap();
    expect(snap.value).toBe('letterImage');
    expect(snap.context.stateTransitionId).toBe(
      'म-letterImage-letterImage-wrong-first',
    );
    expect(snap.context.letterErrors).toBe(1);
    a.stop();
  });

  it('wrong, second attempt → stays in letterImage, stid=wrong-second', () => {
    const a = setupInLetterImage(['म']);
    mockMarkLetter.mockReturnValue(false);
    a.send({ type: 'ANSWER', studentAnswer: 'x1' });
    a.send({ type: 'ANSWER', studentAnswer: 'x2' });

    expect(a.snap().context.stateTransitionId).toBe(
      'म-letterImage-letterImage-wrong-second',
    );
    expect(a.snap().context.letterErrors).toBe(2);
    a.stop();
  });

  it('wrong, third attempt + last wrongLetter → word, stid=word-maxErrors-last', () => {
    const a = setupInLetterImage(['म']);
    mockMarkLetter.mockReturnValue(false);
    a.send({ type: 'ANSWER', studentAnswer: 'x1' });
    a.send({ type: 'ANSWER', studentAnswer: 'x2' });
    a.send({ type: 'ANSWER', studentAnswer: 'x3' });

    const snap = a.snap();
    expect(snap.value).toBe('word');
    expect(snap.context.stateTransitionId).toBe(
      'कमल-letterImage-word-maxErrors-last',
    );
    expect(snap.context.letterErrors).toBe(0); // reset
    a.stop();
  });

  it('wrong, third attempt + more letters → routeWrongLetter, stid=routeWrongLetter-maxErrors-more', () => {
    const a = setupInLetterImage(['म', 'ल']);
    mockMarkLetter.mockReturnValue(false);
    a.send({ type: 'ANSWER', studentAnswer: 'x1' });
    a.send({ type: 'ANSWER', studentAnswer: 'x2' });
    a.send({ type: 'ANSWER', studentAnswer: 'x3' });

    const snap = a.snap();
    expect(snap.value).toBe('letter');
    expect(snap.context.stateTransitionId).toBe(
      'ल-letterImage-routeWrongLetter-maxErrors-more',
    );
    a.stop();
  });
});

// ─── letterNoImage state ──────────────────────────────────────────────────

describe('machine — letterNoImage state (special chars ञ, ण)', () => {
  function setupInLetterNoImage(wrongLetters: string[]): ActorHandle {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: wrongLetters,
    });
    const a = makeActor({ word: 'word', userMessageId: 'mm-1' });
    a.send({ type: 'ANSWER', studentAnswer: 'wrong' });
    return a;
  }

  it('correct first-go + last letter → word, stid=word-correct-first-last', () => {
    const a = setupInLetterNoImage(['ञ']);
    mockMarkLetter.mockReturnValue(true);
    a.send({ type: 'ANSWER', studentAnswer: 'ञ' });

    expect(a.snap().value).toBe('word');
    expect(a.snap().context.stateTransitionId).toBe(
      'word-letterNoImage-word-correct-first-last',
    );
    a.stop();
  });

  it('correct first-go + more letters → routeWrongLetter, stid=routeWrongLetter-correct-first-more', () => {
    const a = setupInLetterNoImage(['ञ', 'क']);
    mockMarkLetter.mockReturnValue(true);
    a.send({ type: 'ANSWER', studentAnswer: 'ञ' });

    expect(a.snap().value).toBe('letter');
    expect(a.snap().context.stateTransitionId).toBe(
      'क-letterNoImage-routeWrongLetter-correct-first-more',
    );
    a.stop();
  });

  it('wrong first-go → stays in letterNoImage, wrong-first stid, pendingIncorrect set', () => {
    const a = setupInLetterNoImage(['ञ']);
    mockMarkLetter.mockReturnValue(false);
    a.send({ type: 'ANSWER', studentAnswer: 'x' });

    const snap = a.snap();
    expect(snap.value).toBe('letterNoImage');
    expect(snap.context.stateTransitionId).toBe(
      'ञ-letterNoImage-letterNoImage-wrong-first',
    );
    expect(snap.context.pendingIncorrect).toEqual(['ञ']);
    a.stop();
  });

  it('correct second-go + last letter → word, stid=word-correct-retry-last', () => {
    const a = setupInLetterNoImage(['ञ']);
    // First answer: wrong. mockMarkLetter is currently false (allMarksFalse).
    a.send({ type: 'ANSWER', studentAnswer: 'x' });
    // Second answer: correct. Set sticky return so every guard call sees true.
    mockMarkLetter.mockReturnValue(true);
    a.send({ type: 'ANSWER', studentAnswer: 'ञ' });

    expect(a.snap().context.stateTransitionId).toBe(
      'word-letterNoImage-word-correct-retry-last',
    );
    a.stop();
  });

  it('wrong second-go + last letter → word, stid=word-wrong-last', () => {
    const a = setupInLetterNoImage(['ञ']);
    mockMarkLetter.mockReturnValue(false);
    a.send({ type: 'ANSWER', studentAnswer: 'x1' });
    a.send({ type: 'ANSWER', studentAnswer: 'x2' });

    expect(a.snap().context.stateTransitionId).toBe(
      'word-letterNoImage-word-wrong-last',
    );
    a.stop();
  });

  it('wrong second-go + more letters → routeWrongLetter, stid=routeWrongLetter-wrong-more', () => {
    const a = setupInLetterNoImage(['ञ', 'क']);
    mockMarkLetter.mockReturnValue(false);
    a.send({ type: 'ANSWER', studentAnswer: 'x1' });
    a.send({ type: 'ANSWER', studentAnswer: 'x2' });

    expect(a.snap().context.stateTransitionId).toBe(
      'क-letterNoImage-routeWrongLetter-wrong-more',
    );
    a.stop();
  });

  it('correct second-go + more letters → routeWrongLetter, stid=correct-retry-more', () => {
    const a = setupInLetterNoImage(['ञ', 'क']);
    a.send({ type: 'ANSWER', studentAnswer: 'x' }); // wrong (mockMarkLetter still false)
    mockMarkLetter.mockReturnValue(true);
    a.send({ type: 'ANSWER', studentAnswer: 'ञ' });

    expect(a.snap().context.stateTransitionId).toBe(
      'क-letterNoImage-routeWrongLetter-correct-retry-more',
    );
    a.stop();
  });
});

// ─── guard error path ─────────────────────────────────────────────────────

describe('machine — checkAnswer guard error path', () => {
  it('the guard rejects an empty studentAnswer (reported via the actor error subscription)', () => {
    // The guard throws when either context.answer or event.studentAnswer is
    // empty. xstate v5 surfaces the error via subscribe({error}). Verify
    // here that the error makes it to the subscriber rather than being
    // silently swallowed.
    const { createActor } = jest.requireActual(
      'xstate',
    ) as typeof import('xstate');
    const actor = createActor(machine, {
      input: { word: 'कमल', userMessageId: 'mm-1' },
    });
    const errors: Error[] = [];
    actor.subscribe({ error: (e) => errors.push(e as Error) });
    actor.start();
    actor.send({ type: 'ANSWER', studentAnswer: '' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/checkAnswer guard requires/);
    actor.stop();
  });
});

// ─── mutation hardening: full transition outcomes ────────────────────────────
// The tests above pin the stateTransitionId of each branch. These pin the rest
// of each transition's observable effect — target state, answerCorrect, the
// pending-score arrays, and the error counters — so the assign()/action/guard
// mutants on every branch are caught.

import {
  WELCOME_MESSAGE_STATE_TRANSITION_ID,
  AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID,
  STALE_LESSON_RESTART_STATE_TRANSITION_ID,
} from './literacy-lesson.machine';

const ANSWER = (studentAnswer: string) =>
  ({ type: 'ANSWER', studentAnswer }) as const;

// Reach the `word` state with wordErrors already at 1 via an end-matra error
// (which also leaves pendingCorrect = Array(word), dirtying the score arrays).
function wordWithOneError(word = 'कमल'): ActorHandle {
  mockDetectIncorrectEndMatra.mockReturnValueOnce(true);
  const a = makeActor({ word, userMessageId: 'mm-1' });
  a.send(ANSWER('matra'));
  allMarksFalse();
  return a;
}

describe('machine — word state full outcomes', () => {
  it('correct-first: complete, answerCorrect true, pendingCorrect=Array(word), pendingIncorrect empty', () => {
    mockMarkWord.mockReturnValue(true);
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send(ANSWER('कमल'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('complete');
    expect(c.answerCorrect).toBe(true);
    expect(c.pendingCorrect).toEqual(['क', 'म', 'ल']);
    expect(c.pendingIncorrect).toEqual([]);
    expect(c.wordErrors).toBe(0);
    // checkAnswer guard forwards both args to the marker fn (kills params.fn({}))
    expect(mockMarkWord).toHaveBeenCalledWith({
      correctAnswer: 'कमल',
      studentAnswer: 'कमल',
    });
    a.stop();
  });

  it('correct-retry clears leaked pendingCorrect (kills clearPendingScores on the retry branch)', () => {
    const a = wordWithOneError();
    expect(a.snap().context.pendingCorrect).toEqual(['क', 'म', 'ल']); // leaked in
    mockMarkWord.mockReturnValue(true);
    a.send(ANSWER('कमल'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('complete');
    expect(c.answerCorrect).toBe(true);
    expect(c.pendingCorrect).toEqual([]); // cleared, not re-set
    expect(c.pendingIncorrect).toEqual([]);
    a.stop();
  });

  it('endMatra-first: stays in word, answerCorrect false, wordErrors incremented to 1, pendingCorrect set', () => {
    mockDetectIncorrectEndMatra.mockReturnValue(true);
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send(ANSWER('कमलि'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('word');
    expect(c.answerCorrect).toBe(false);
    expect(c.wordErrors).toBe(1);
    expect(c.pendingCorrect).toEqual(['क', 'म', 'ल']);
    a.stop();
  });

  it('endMatra-retry: wordErrors incremented to 2, pendingCorrect cleared (not re-set)', () => {
    const a = wordWithOneError();
    mockDetectIncorrectEndMatra.mockReturnValue(true);
    a.send(ANSWER('कमलि'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('word');
    expect(c.answerCorrect).toBe(false);
    expect(c.wordErrors).toBe(2);
    expect(c.pendingCorrect).toEqual([]);
    a.stop();
  });

  it('middleMatra-first: wordErrors→1, pendingCorrect set', () => {
    mockDetectIncorrectMiddleMatra.mockReturnValue(true);
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send(ANSWER('कमिल'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('word');
    expect(c.answerCorrect).toBe(false);
    expect(c.wordErrors).toBe(1);
    expect(c.pendingCorrect).toEqual(['क', 'म', 'ल']);
    a.stop();
  });

  it('middleMatra-retry: wordErrors→2, pendingCorrect cleared', () => {
    const a = wordWithOneError();
    mockDetectIncorrectMiddleMatra.mockReturnValue(true);
    a.send(ANSWER('कमिल'));
    const c = a.snap().context;
    expect(c.wordErrors).toBe(2);
    expect(c.pendingCorrect).toEqual([]);
    expect(a.snap().context.stateTransitionId).toBe(
      'कमल-word-word-middleMatra-retry',
    );
    a.stop();
  });

  it('insertion-first: wordErrors→1, pendingCorrect set', () => {
    mockDetectInsertion.mockReturnValue(true);
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send(ANSWER('कमालिकल'));
    const c = a.snap().context;
    expect(c.wordErrors).toBe(1);
    expect(c.pendingCorrect).toEqual(['क', 'म', 'ल']);
    a.stop();
  });

  it('insertion-retry: wordErrors→2, pendingCorrect cleared', () => {
    const a = wordWithOneError();
    mockDetectInsertion.mockReturnValue(true);
    a.send(ANSWER('कमालिकल'));
    const c = a.snap().context;
    expect(c.wordErrors).toBe(2);
    expect(c.pendingCorrect).toEqual([]);
    expect(a.snap().context.stateTransitionId).toBe(
      'कमल-word-word-insertion-retry',
    );
    a.stop();
  });

  it('loopBack fires at wordErrors=1 (kills >=1 boundary): stays in word, wordErrors→2', () => {
    const a = wordWithOneError(); // wordErrors=1, all marks false
    a.send(ANSWER('still-wrong')); // no matra/insertion/markWord
    const c = a.snap().context;
    expect(a.snap().value).toBe('word');
    expect(c.answerCorrect).toBe(false);
    expect(c.wordErrors).toBe(2);
    expect(c.stateTransitionId).toBe('कमल-word-word-loopBack');
    a.stop();
  });

  it('maxErrors at wordErrors>=2: complete, answerCorrect false', () => {
    const a = wordWithOneError(); // 1
    mockDetectIncorrectEndMatra.mockReturnValueOnce(true);
    a.send(ANSWER('matra2')); // endMatra-retry → wordErrors=2
    a.send(ANSWER('totally-wrong')); // wordErrors>=2 → maxErrors
    const c = a.snap().context;
    expect(a.snap().value).toBe('complete');
    expect(c.answerCorrect).toBe(false);
    expect(c.stateTransitionId).toBe('कमल-word-complete-maxErrors');
    a.stop();
  });

  it('first wrong word (wordErrors=0) routes to the letter loop, NOT loopBack (kills loopBack guard → true)', () => {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: ['म', 'ल'],
    });
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send(ANSWER('different'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('letter');
    expect(c.answerCorrect).toBe(false);
    expect(c.wordErrors).toBe(1);
    expect(c.wrongLetters).toEqual(['म', 'ल']);
    a.stop();
  });
});

describe('machine — letter state full outcomes', () => {
  function inLetter(wrongLetters: string[]): ActorHandle {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: wrongLetters,
    });
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send(ANSWER('wrong-word'));
    return a;
  }

  it('correct + last: back to word, answerCorrect true, pendingCorrect=[letter], wrongLetters drained', () => {
    const a = inLetter(['म']);
    mockMarkLetter.mockReturnValue(true);
    a.send(ANSWER('म'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('word');
    expect(c.answerCorrect).toBe(true);
    expect(c.pendingCorrect).toEqual(['म']);
    expect(c.wrongLetters).toEqual([]); // dropFirstWrongLetter
    a.stop();
  });

  it('correct + more: routeWrongLetter→letter, pendingCorrect=[first], first letter dropped', () => {
    const a = inLetter(['म', 'ल']);
    mockMarkLetter.mockReturnValue(true);
    a.send(ANSWER('म'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('letter');
    expect(c.answerCorrect).toBe(true);
    expect(c.pendingCorrect).toEqual(['म']);
    expect(c.wrongLetters).toEqual(['ल']); // dropFirstWrongLetter
    a.stop();
  });

  it('wrong: →image, answerCorrect false, pendingIncorrect=[letter]', () => {
    const a = inLetter(['म']);
    mockMarkLetter.mockReturnValue(false);
    a.send(ANSWER('x'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('image');
    expect(c.answerCorrect).toBe(false);
    expect(c.pendingIncorrect).toEqual(['म']);
    expect(c.wrongLetters).toEqual(['म']); // NOT dropped on wrong
    a.stop();
  });
});

describe('machine — image state full outcomes', () => {
  function inImage(wrongLetters: string[]): ActorHandle {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: wrongLetters,
    });
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send(ANSWER('wrong-word'));
    mockMarkLetter.mockReturnValue(false);
    a.send(ANSWER('x')); // letter → image
    mockMarkLetter.mockReset();
    allMarksFalse();
    return a;
  }

  it('correct image: →letterImage, answerCorrect true, leaked pendingIncorrect cleared', () => {
    const a = inImage(['म']);
    expect(a.snap().context.pendingIncorrect).toEqual(['म']); // leaked from letter-wrong
    mockMarkImage.mockReturnValue(true);
    a.send(ANSWER('img'));
    expect(a.snap().value).toBe('letterImage');
    expect(a.snap().context.answerCorrect).toBe(true);
    expect(a.snap().context.pendingIncorrect).toEqual([]); // clearPendingScores
    a.stop();
  });

  it('wrong first attempt: stays in image, imageErrors→1, answerCorrect false, leaked pendingIncorrect cleared', () => {
    const a = inImage(['म']);
    mockMarkImage.mockReturnValue(false);
    a.send(ANSWER('x'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('image');
    expect(c.imageErrors).toBe(1);
    expect(c.answerCorrect).toBe(false);
    expect(c.pendingIncorrect).toEqual([]); // clearPendingScores cleared the leak
    a.stop();
  });

  it('wrong second attempt: →letterImage, imageErrors reset to 0 (kills resetToZero)', () => {
    const a = inImage(['म']);
    mockMarkImage.mockReturnValue(false);
    a.send(ANSWER('x1')); // imageErrors=1
    expect(a.snap().context.imageErrors).toBe(1);
    a.send(ANSWER('x2')); // >=1 → letterImage, reset
    const c = a.snap().context;
    expect(a.snap().value).toBe('letterImage');
    expect(c.imageErrors).toBe(0);
    expect(c.answerCorrect).toBe(false);
    a.stop();
  });
});

describe('machine — letterImage state full outcomes', () => {
  function inLetterImage(wrongLetters: string[]): ActorHandle {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: wrongLetters,
    });
    const a = makeActor({ word: 'कमल', userMessageId: 'mm-1' });
    a.send(ANSWER('wrong-word'));
    mockMarkLetter.mockReturnValue(false);
    a.send(ANSWER('x')); // letter → image
    mockMarkImage.mockReturnValue(true);
    a.send(ANSWER('img')); // image → letterImage
    allMarksFalse();
    return a;
  }

  it('correct + last: →word, answerCorrect true, wrongLetters drained', () => {
    const a = inLetterImage(['म']);
    mockMarkLetter.mockReturnValue(true);
    a.send(ANSWER('म'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('word');
    expect(c.answerCorrect).toBe(true);
    expect(c.wrongLetters).toEqual([]);
    a.stop();
  });

  it('correct + more: →letter, first letter dropped', () => {
    const a = inLetterImage(['म', 'ल']);
    mockMarkLetter.mockReturnValue(true);
    a.send(ANSWER('म'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('letter');
    expect(c.answerCorrect).toBe(true);
    expect(c.wrongLetters).toEqual(['ल']);
    a.stop();
  });

  it('wrong first: letterErrors→1', () => {
    const a = inLetterImage(['म']);
    mockMarkLetter.mockReturnValue(false);
    a.send(ANSWER('x'));
    expect(a.snap().value).toBe('letterImage');
    expect(a.snap().context.letterErrors).toBe(1);
    expect(a.snap().context.answerCorrect).toBe(false);
    a.stop();
  });

  it('wrong second: letterErrors→2', () => {
    const a = inLetterImage(['म']);
    mockMarkLetter.mockReturnValue(false);
    a.send(ANSWER('x1'));
    a.send(ANSWER('x2'));
    expect(a.snap().context.letterErrors).toBe(2);
    a.stop();
  });

  it('wrong third + last: →word, letterErrors reset to 0, wrongLetters drained', () => {
    const a = inLetterImage(['म']);
    mockMarkLetter.mockReturnValue(false);
    a.send(ANSWER('x1'));
    a.send(ANSWER('x2'));
    a.send(ANSWER('x3'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('word');
    expect(c.letterErrors).toBe(0);
    expect(c.wrongLetters).toEqual([]);
    expect(c.answerCorrect).toBe(false);
    a.stop();
  });

  it('wrong third + more (kills wrongLetters.length > 1 boundary): →letter, letterErrors reset, first dropped', () => {
    const a = inLetterImage(['म', 'ल']);
    mockMarkLetter.mockReturnValue(false);
    a.send(ANSWER('x1'));
    a.send(ANSWER('x2'));
    a.send(ANSWER('x3'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('letter');
    expect(c.letterErrors).toBe(0);
    expect(c.wrongLetters).toEqual(['ल']);
    a.stop();
  });
});

describe('machine — letterNoImage state full outcomes', () => {
  function inLetterNoImage(wrongLetters: string[]): ActorHandle {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: wrongLetters,
    });
    const a = makeActor({ word: 'word', userMessageId: 'mm-1' });
    a.send(ANSWER('wrong'));
    return a;
  }

  it('correct first + last: →word, answerCorrect true, pendingCorrect=[letter], drained', () => {
    const a = inLetterNoImage(['ञ']);
    mockMarkLetter.mockReturnValue(true);
    a.send(ANSWER('ञ'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('word');
    expect(c.answerCorrect).toBe(true);
    expect(c.pendingCorrect).toEqual(['ञ']);
    expect(c.wrongLetters).toEqual([]);
    a.stop();
  });

  it('correct first + more: →routeWrongLetter, pendingCorrect=[first], first dropped', () => {
    const a = inLetterNoImage(['ञ', 'क']);
    mockMarkLetter.mockReturnValue(true);
    a.send(ANSWER('ञ'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('letter');
    expect(c.answerCorrect).toBe(true);
    expect(c.pendingCorrect).toEqual(['ञ']);
    expect(c.wrongLetters).toEqual(['क']);
    a.stop();
  });

  it('wrong first: stays, letterNoImageErrors→1, pendingIncorrect=[letter]', () => {
    const a = inLetterNoImage(['ञ']);
    mockMarkLetter.mockReturnValue(false);
    a.send(ANSWER('x'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('letterNoImage');
    expect(c.answerCorrect).toBe(false);
    expect(c.letterNoImageErrors).toBe(1);
    expect(c.pendingIncorrect).toEqual(['ञ']);
    a.stop();
  });

  it('correct second + last: →word, answerCorrect true, errors reset, drained, leaked pendingIncorrect cleared', () => {
    const a = inLetterNoImage(['ञ']);
    a.send(ANSWER('x')); // wrong → letterNoImageErrors=1, pendingIncorrect=['ञ']
    expect(a.snap().context.pendingIncorrect).toEqual(['ञ']);
    mockMarkLetter.mockReturnValue(true);
    a.send(ANSWER('ञ'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('word');
    expect(c.answerCorrect).toBe(true);
    expect(c.letterNoImageErrors).toBe(0);
    expect(c.wrongLetters).toEqual([]);
    expect(c.pendingIncorrect).toEqual([]); // clearPendingScores
    a.stop();
  });

  it('correct second + more: →routeWrongLetter, errors reset, first dropped, leaked pendingIncorrect cleared', () => {
    const a = inLetterNoImage(['ञ', 'क']);
    a.send(ANSWER('x'));
    mockMarkLetter.mockReturnValue(true);
    a.send(ANSWER('ञ'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('letter');
    expect(c.answerCorrect).toBe(true);
    expect(c.letterNoImageErrors).toBe(0);
    expect(c.wrongLetters).toEqual(['क']);
    expect(c.pendingIncorrect).toEqual([]); // clearPendingScores
    a.stop();
  });

  it('wrong second + last: →word, answerCorrect false, errors reset, drained, leaked pendingIncorrect cleared', () => {
    const a = inLetterNoImage(['ञ']);
    mockMarkLetter.mockReturnValue(false);
    a.send(ANSWER('x1'));
    a.send(ANSWER('x2'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('word');
    expect(c.answerCorrect).toBe(false);
    expect(c.letterNoImageErrors).toBe(0);
    expect(c.wrongLetters).toEqual([]);
    expect(c.pendingIncorrect).toEqual([]); // clearPendingScores cleared the leak
    a.stop();
  });

  it('wrong second + more: →routeWrongLetter, errors reset, first dropped, leaked pendingIncorrect cleared', () => {
    const a = inLetterNoImage(['ञ', 'क']);
    mockMarkLetter.mockReturnValue(false);
    a.send(ANSWER('x1'));
    a.send(ANSWER('x2'));
    const c = a.snap().context;
    expect(a.snap().value).toBe('letter');
    expect(c.answerCorrect).toBe(false);
    expect(c.letterNoImageErrors).toBe(0);
    expect(c.wrongLetters).toEqual(['क']);
    expect(c.pendingIncorrect).toEqual([]); // clearPendingScores cleared the leak
    a.stop();
  });
});

describe('machine — state entry sets answer to the current wrong letter', () => {
  function wrongWord(incorrectChars: string[], word = 'कमल'): ActorHandle {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars,
    });
    const a = makeActor({ word, userMessageId: 'mm-1' });
    a.send(ANSWER('wrong-word'));
    return a;
  }

  it('letter entry sets answer to wrongLetters[0]', () => {
    const a = wrongWord(['म']);
    expect(a.snap().value).toBe('letter');
    expect(a.snap().context.answer).toBe('म');
    a.stop();
  });

  it('image entry sets answer to wrongLetters[0]', () => {
    const a = wrongWord(['म']);
    mockMarkLetter.mockReturnValue(false);
    a.send(ANSWER('x')); // letter → image
    expect(a.snap().value).toBe('image');
    expect(a.snap().context.answer).toBe('म');
    a.stop();
  });

  it('letterImage entry sets answer to wrongLetters[0]', () => {
    const a = wrongWord(['म']);
    mockMarkLetter.mockReturnValue(false);
    a.send(ANSWER('x'));
    mockMarkImage.mockReturnValue(true);
    a.send(ANSWER('img')); // image → letterImage
    expect(a.snap().value).toBe('letterImage');
    expect(a.snap().context.answer).toBe('म');
    a.stop();
  });

  it('letterNoImage entry sets answer to wrongLetters[0]', () => {
    const a = wrongWord(['ञ'], 'word');
    expect(a.snap().value).toBe('letterNoImage');
    expect(a.snap().context.answer).toBe('ञ');
    a.stop();
  });

  it('the wrong-word transition forwards both args to identifyCharacterStatus', () => {
    wrongWord(['म']);
    expect(mockIdentifyCharacterStatus).toHaveBeenCalledWith({
      correctAnswer: 'कमल',
      studentAnswer: 'wrong-word',
    });
  });
});

describe('machine — routing + constants', () => {
  it('routes ण (the second NO_IMAGE_LETTER) to letterNoImage', () => {
    mockIdentifyCharacterStatus.mockReturnValue({
      correctChars: [],
      incorrectChars: ['ण'],
    });
    const a = makeActor({ word: 'word', userMessageId: 'mm-1' });
    a.send(ANSWER('wrong'));
    expect(a.snap().value).toBe('letterNoImage');
    a.stop();
  });

  it('exposes the externally-consumed state-transition-id constants', () => {
    expect(WELCOME_MESSAGE_STATE_TRANSITION_ID).toBe('welcome-message');
    expect(AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID).toBe('audio-only-request');
    expect(STALE_LESSON_RESTART_STATE_TRANSITION_ID).toBe(
      'stale-lesson-restart',
    );
  });
});
