import {
  SENTENCE_RECENT_ROWS_WINDOW,
  TurnRow,
  computeSentenceBandSignal,
} from './sentence-band-signal.utils';

// Builds a newest-first turn array from compact specs; rn is assigned by
// position (1 = newest).
function turns(
  rows: Array<{ done?: boolean; stid?: string | null }>,
): TurnRow[] {
  return rows.map((r, i) => ({
    rn: i + 1,
    is_done: r.done ?? false,
    stid: r.stid === undefined ? 'कमल-start-word-initial' : r.stid,
  }));
}

// A completed passage lesson (3 rows, newest first): comprehension done row,
// then the read outcome, then the lesson-entry prompt.
function passedLesson(
  firstTry = true,
): Array<{ done?: boolean; stid?: string }> {
  return [
    { done: true, stid: 'opt1-comprehension-complete' },
    {
      stid: firstTry
        ? 'p1-sentence-comprehension-correct-first'
        : 'p1-sentence-comprehension-correct-retry',
    },
    { stid: 'sentence-start-sentence-initial' },
  ];
}

// A completed LEVEL-8 passage lesson (2 rows, newest first): the read itself
// is the done row — no comprehension state at level 8.
function passedLevel8Lesson(
  firstTry = true,
): Array<{ done?: boolean; stid?: string }> {
  return [
    {
      done: true,
      stid: firstTry
        ? 'p1-sentence-complete-correct-first'
        : 'p1-sentence-complete-correct-retry',
    },
    { stid: 'sentence-start-sentence-initial' },
  ];
}

// A failed-out lesson that also visited the image tier of the drill loop.
function failedLesson(opts: { image?: boolean } = {}): Array<{
  done?: boolean;
  stid?: string;
}> {
  return [
    { done: true, stid: 'sentence-sentence-complete-maxErrors' },
    ...(opts.image ? [{ stid: 'क-letter-image-wrong' }] : []),
    { stid: 'घर-sentence-word-drillWord' },
    { stid: 'sentence-start-sentence-initial' },
  ];
}

describe('computeSentenceBandSignal', () => {
  it('excludes the still-open turn (rows before the first done row)', () => {
    // Open-turn rows carry a first-try-pass stid that must NOT be scored.
    const signal = computeSentenceBandSignal(
      turns([
        { stid: 'p9-sentence-comprehension-correct-first' }, // open turn
        ...passedLesson(false),
        ...passedLesson(true),
        ...passedLesson(true), // 3rd completion keeps rule 2 out of the way
      ]),
      10,
    );
    expect(signal.bothFirstTryPass).toBe(false);
    expect(signal.decision).toBe('hold');
  });

  it('ignores a truncated oldest lesson (window full, lower boundary invisible)', () => {
    // Window exactly full: the oldest group has no closing done row below
    // it, so only ONE valid lesson exists → hold despite two "passes".
    const full = [
      ...passedLesson(true),
      ...passedLesson(true),
      // filler rows of the clipped older group (no done row in window)
      ...Array.from({ length: SENTENCE_RECENT_ROWS_WINDOW - 6 }, () => ({
        stid: 'क-letter-image-wrong',
      })),
    ];
    expect(full).toHaveLength(SENTENCE_RECENT_ROWS_WINDOW);
    // lifetime 2 keeps the churn rule out of the way — this test is about
    // truncation only.
    const signal = computeSentenceBandSignal(turns(full), 2);
    // First lesson valid (closed by the second's done row); the second is
    // the unbounded oldest group and is discarded — its image-tier rows
    // must not contaminate anything.
    expect(signal.bothFirstTryPass).toBe(false);
    expect(signal.bothEnteredImage).toBe(false);
    expect(signal.decision).toBe('hold');
  });

  it('scores the oldest lesson when the window holds the entire history', () => {
    const signal = computeSentenceBandSignal(
      turns([...passedLesson(true), ...passedLesson(true)]), // 6 rows < 18
      2,
    );
    expect(signal.bothFirstTryPass).toBe(true);
    expect(signal.decision).toBe('increment');
  });

  it('both lessons first-try pass → increment', () => {
    const signal = computeSentenceBandSignal(
      turns([
        ...passedLesson(true),
        ...passedLesson(true),
        ...passedLesson(false),
      ]),
      10,
    );
    expect(signal.decision).toBe('increment');
  });

  it('level-8 first-try passes (no comprehension row) count → increment', () => {
    const signal = computeSentenceBandSignal(
      turns([
        ...passedLevel8Lesson(true),
        ...passedLesson(true),
        ...passedLevel8Lesson(false),
      ]),
      10,
    );
    expect(signal.decision).toBe('increment');
  });

  it('a level-8 retry pass is not a first-try pass → hold', () => {
    const signal = computeSentenceBandSignal(
      turns([
        ...passedLevel8Lesson(false),
        ...passedLesson(true),
        ...passedLesson(true),
      ]),
      10,
    );
    expect(signal.decision).toBe('hold');
  });

  it('one of two first-try passes → hold', () => {
    const signal = computeSentenceBandSignal(
      turns([
        ...passedLesson(true),
        ...passedLesson(false),
        ...passedLesson(true),
      ]),
      10,
    );
    expect(signal.bothFirstTryPass).toBe(false);
    expect(signal.decision).toBe('hold');
  });

  it('both lessons entered the image tier → decrement', () => {
    const signal = computeSentenceBandSignal(
      turns([
        ...failedLesson({ image: true }),
        { done: true, stid: 'opt2-comprehension-complete' },
        { stid: 'क-letter-image-wrong' },
        { stid: 'p2-sentence-comprehension-correct-retry' },
        ...passedLesson(false), // 3rd completion keeps rule 2 out of the way
      ]),
      10,
    );
    expect(signal.bothEnteredImage).toBe(true);
    expect(signal.decision).toBe('decrement');
    expect(signal.lowCompletionDecrement).toBe(false);
  });

  it('both lessons failed out → decrement', () => {
    const signal = computeSentenceBandSignal(
      turns([...failedLesson(), ...failedLesson(), ...passedLesson(false)]),
      10,
    );
    expect(signal.bothFailedOut).toBe(true);
    expect(signal.decision).toBe('decrement');
    expect(signal.lowCompletionDecrement).toBe(false); // rule 5, not rule 2
  });

  it('mixed decrement evidence (image in one, failed-out in the other) → hold', () => {
    const signal = computeSentenceBandSignal(
      turns([
        ...failedLesson(), // failed out, never reached image tier
        { done: true, stid: 'opt1-comprehension-complete' },
        { stid: 'क-letter-image-wrong' }, // image tier, but passed out
        { stid: 'p1-sentence-comprehension-correct-retry' },
        ...passedLesson(false), // 3rd completion keeps rule 2 out of the way
      ]),
      10,
    );
    expect(signal.bothEnteredImage).toBe(false);
    expect(signal.bothFailedOut).toBe(false);
    expect(signal.decision).toBe('hold');
  });

  it('churning: <3 done in window with lifetime ≥3 → decrement', () => {
    // 18 rows, one lone completion — the student keeps starting turns
    // without finishing lessons.
    const full = [
      ...passedLesson(false),
      ...Array.from({ length: SENTENCE_RECENT_ROWS_WINDOW - 3 }, () => ({})),
    ];
    const signal = computeSentenceBandSignal(turns(full), 10);
    expect(signal.doneInWindow).toBe(1);
    expect(signal.lowCompletionDecrement).toBe(true);
    expect(signal.decision).toBe('decrement');
  });

  it('new student: <3 done in window AND lifetime <3 → hold', () => {
    const signal = computeSentenceBandSignal(
      turns([...passedLesson(false), {}, {}]),
      1,
    );
    expect(signal.lowCompletionDecrement).toBe(false);
    expect(signal.decision).toBe('hold');
  });

  it('rule 1 beats rule 2: two first-try passes increment despite doneInWindow < 3', () => {
    const signal = computeSentenceBandSignal(
      turns([...passedLesson(true), ...passedLesson(true)]), // 2 done rows
      10, // lifetime ≥ 3 would otherwise trigger the churn decrement
    );
    expect(signal.doneInWindow).toBe(2);
    expect(signal.decision).toBe('increment');
    expect(signal.lowCompletionDecrement).toBe(false);
  });

  it('tolerates null stids anywhere', () => {
    const signal = computeSentenceBandSignal(
      turns([
        { stid: null },
        { done: true, stid: null },
        { stid: null },
        { done: true, stid: null },
        { stid: null },
        { done: true, stid: null },
      ]),
      10,
    );
    expect(signal.decision).toBe('hold');
    expect(signal.doneInWindow).toBe(3);
  });
});
