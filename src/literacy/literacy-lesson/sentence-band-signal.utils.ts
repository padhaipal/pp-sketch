/**
 * Sentence-band (level ≥ 8) progression signal, computed from the raw
 * recent-turn rows so the grouping is pure and unit-testable (no SQL, no IO
 * — same pattern as evaluate-answer.utils.ts).
 *
 * A lesson is not an entity: it is a group of consecutive
 * literacy_lesson_states rows ending in a done row — the done row plus the
 * (older) rows after it, up to but excluding the next done row. Rows newer
 * than the newest done row are the still-open turn and score nothing.
 *
 * A lesson is VALID only when its lower boundary is visible: the next-older
 * done row sits inside the window, or the window holds the user's entire
 * history (fewer than SENTENCE_RECENT_ROWS_WINDOW rows). The oldest group is
 * otherwise unbounded — the window may have clipped its rows — and scoring
 * it would let truncated/abandoned turns contaminate lesson 2's flags, so it
 * is ignored, never scored.
 *
 * Non-lesson stids (welcome, audio-only, stale-restart) are never persisted
 * into snapshots — they only decorate the outbound stid array — so no
 * exclusion pass is needed here (verified against inbound.processor.ts and
 * processAnswer's return shape).
 */

// Row-scan window for the recent-turns query — also the "entire history is
// visible" threshold for validating the oldest lesson group.
export const SENTENCE_RECENT_ROWS_WINDOW = 18;

// Marks a passage read correctly on the first attempt.
const FIRST_TRY_PASS_SUFFIX = '-sentence-comprehension-correct-first';
// The only entry transition into the image tier of the word drill loop.
const ENTERED_IMAGE_SUFFIX = '-letter-image-wrong';
// The two-strikes sentence exit (literacy-lesson.machine.ts); a lesson
// "failed out" only when its DONE row carries exactly this stid.
const FAILED_OUT_STID = 'sentence-sentence-complete-maxErrors';

export interface TurnRow {
  rn: number;
  is_done: boolean;
  stid: string | null;
}

export interface SentenceBandSignal {
  decision: 'increment' | 'decrement' | 'hold';
  doneInWindow: number;
  lowCompletionDecrement: boolean;
  bothFirstTryPass: boolean;
  bothEnteredImage: boolean;
  bothFailedOut: boolean;
}

interface LessonFlags {
  firstTryPass: boolean;
  enteredImage: boolean;
  failedOut: boolean;
}

function flagsOf(rows: TurnRow[]): LessonFlags {
  // rows[0] is the group's done row (newest of the group by construction).
  const stids = rows.map((r) => r.stid ?? '');
  return {
    firstTryPass: stids.some((s) => s.endsWith(FIRST_TRY_PASS_SUFFIX)),
    enteredImage: stids.some((s) => s.endsWith(ENTERED_IMAGE_SUFFIX)),
    failedOut: stids[0] === FAILED_OUT_STID,
  };
}

export function computeSentenceBandSignal(
  turns: TurnRow[],
  lifetimeDoneCount: number,
): SentenceBandSignal {
  const sorted = [...turns].sort((a, b) => a.rn - b.rn); // newest first
  const doneInWindow = sorted.filter((t) => t.is_done).length;

  // Group newest → oldest: a done row starts a lesson and CLOSES the one
  // being collected (that older done row is the collected lesson's lower
  // boundary, so it is valid). Rows before the first done row (the open
  // turn) never enter a group.
  const validLessons: LessonFlags[] = [];
  let current: TurnRow[] | null = null;
  for (const turn of sorted) {
    if (turn.is_done) {
      if (current) {
        validLessons.push(flagsOf(current));
      }
      current = [turn];
    } else if (current) {
      current.push(turn);
    }
  }
  if (current && sorted.length < SENTENCE_RECENT_ROWS_WINDOW) {
    // Window holds the whole history — the oldest group's lower boundary is
    // the beginning of time, so it is complete and scorable.
    validLessons.push(flagsOf(current));
  }

  const [l1, l2] = validLessons;
  const bothFirstTryPass = Boolean(
    l1 && l2 && l1.firstTryPass && l2.firstTryPass,
  );
  const bothEnteredImage = Boolean(
    l1 && l2 && l1.enteredImage && l2.enteredImage,
  );
  const bothFailedOut = Boolean(l1 && l2 && l1.failedOut && l2.failedOut);
  const lowCompletion = doneInWindow < 3 && lifetimeDoneCount >= 3;

  // First match wins. Rule 1 outranks the low-completion decrement so two
  // fresh first-try passes still increment even when older history is
  // sparse; rules 4/5 stay separate so mixed decrement evidence (image in
  // one lesson, failed-out in the other) never combines.
  let decision: SentenceBandSignal['decision'];
  let lowCompletionDecrement = false;
  if (bothFirstTryPass) {
    decision = 'increment';
  } else if (lowCompletion) {
    decision = 'decrement';
    lowCompletionDecrement = true;
  } else if (validLessons.length < 2) {
    decision = 'hold';
  } else if (bothEnteredImage || bothFailedOut) {
    decision = 'decrement';
  } else {
    decision = 'hold';
  }

  return {
    decision,
    doneInWindow,
    lowCompletionDecrement,
    bothFirstTryPass,
    bothEnteredImage,
    bothFailedOut,
  };
}
