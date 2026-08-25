# sentence-band-signal.utils.ts — sentence-band progression signal

Pure module (no IO, no injection — same pattern as
evaluate-answer.utils.ts). `computeSentenceBandSignal(turns,
lifetimeDoneCount)` turns the raw recent literacy_lesson_states rows into
the level decision for the sentence band (level ≥ 8). The SQL in
selectNextString ships only `recent_turns` ({rn, is_done, stid}, newest
first, capped at SENTENCE_RECENT_ROWS_WINDOW = 18 — the constant lives
HERE and is imported by the service) plus a lifetime done count.

## Grouping (newest → oldest)

- Rows before the first done row are the still-open turn — excluded.
- A lesson = a done row plus the (older) rows after it, up to but excluding
  the next done row.
- A lesson is VALID only when its lower boundary is visible: the next-older
  done row is in the window, OR the window holds the user's entire history
  (turns.length < SENTENCE_RECENT_ROWS_WINDOW). The unbounded oldest group
  is otherwise ignored, never scored — the window may have clipped its rows
  and scoring it would contaminate lesson 2's flags.
- Non-lesson stids (welcome / audio-only / stale-restart) never appear in
  persisted snapshots (they only decorate the outbound stid array), so no
  exclusion pass is needed.

## Per-lesson booleans (null stid ⇒ '')

- `firstTryPass` — any stid ending `-sentence-comprehension-correct-first`.
- `enteredImage` — any stid ending `-letter-image-wrong` (the only entry
  transition into the image tier of the drill loop).
- `failedOut` — the DONE row's stid is exactly
  `sentence-sentence-complete-maxErrors`.

## Decision (first match wins; L1/L2 = two most recent VALID lessons)

1. L1 and L2 both firstTryPass → increment.
2. doneInWindow < 3 AND lifetimeDoneCount ≥ 3 → decrement
   (`lowCompletionDecrement`) — churning through turns without finishing
   lessons; the lifetime gate protects new students, and rule 1 outranking
   this means two fresh first-try passes still increment.
3. Fewer than 2 valid lessons → hold.
4. Both enteredImage → decrement.
5. Both failedOut → decrement (mixed image/failed evidence never combines).
6. Otherwise hold.

Returns the decision plus observability fields the service puts on the
span: doneInWindow, lowCompletionDecrement, bothFirstTryPass,
bothEnteredImage, bothFailedOut.
