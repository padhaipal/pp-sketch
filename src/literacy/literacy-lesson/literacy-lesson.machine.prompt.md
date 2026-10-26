
## 2026-07: comprehension state + passage lessons

- Context gained `passageId` (media_metadata id of the reading passage; null
  for word lessons). Input gained optional `passageId`.
- Events are now a union: `ANSWER` | `COMPREHENSION_ANSWER {answerId,
  answerCorrect}` (the service resolves the tapped option's correctness — the
  machine never touches the DB). The `checkAnswer` guard returns false for
  non-ANSWER events.
- Sentence state: correct (first/retry) now targets the new `comprehension`
  state with stids `${passageId}-sentence-comprehension-correct-first|retry`
  (the old `sentence-sentence-complete-correct-*` stids are GONE). Sentence
  guards call `assessSentence(...).passed` from `sentence-assessment.ts`
  (2026-08: word-level Needleman–Wunsch, per-engine fusion, 10% error
  budget). First failure drills
  `selectDrillWord(assessSentence(...).words)` (substituted/omitted words
  only, largest akshara distance, random ties, never a word with a
  conjunct/nukta — i.e. any code point outside TEACHABLE_GRAPHEMES); when no
  teachable word qualifies the sentence re-enters itself with stid
  `sentence-sentence-wrong-retry` and sentenceErrors++ (so max two read
  attempts still holds).
- `comprehension` state: COMPREHENSION_ANSWER → complete with stid
  `${answerId}-comprehension-complete` (no retry); a voice ANSWER while
  waiting re-sends the flow via `…-sentence-comprehension-correct-retry` and
  records nothing.

## 2026-09: comprehension outcome stids (not machine transitions)

`COMPREHENSION_ANSWER_CORRECT_STATE_TRANSITION_ID` /
`COMPREHENSION_ANSWER_INCORRECT_STATE_TRANSITION_ID`
(`comprehension-answer-correct|incorrect`) are exported here beside the other
fixed stids but the machine never emits them: `COMPREHENSION_ANSWER →
complete` still sets only `${answerId}-comprehension-complete`. The service
appends the outcome stid to what it returns (literacy-lesson.service.prompt.md).

## 2026-09: level 11+ read-in-flow lessons

- Input/context gained `readInFlow` (boolean; old snapshots rehydrate with
  undefined = false). Set by the service when the STUDENT's selected level
  ≥ PASSAGE_FLOW_LEVEL_THRESHOLD (11) and a passage was selected.
- With `readInFlow`, the initial stid is
  `${passageId}-passage-comprehension-initial` and the `start` router goes
  straight to `comprehension`: no `sentence` state, no read-aloud, no word or
  letter drill, no reading-speed stid. The passage text is shown INSIDE the
  flow (service returns `flowPassageText`; the processor puts it in
  `flow_action_payload.data.passage_text` and uses the passage-variant flow
  asset). Everything from `comprehension` on is unchanged: tap →
  `${answerId}-comprehension-complete` → complete; voice note → nudge
  (`…-sentence-comprehension-correct-retry`, records nothing, re-sends the
  flow — still with the passage inside).
- Levels 8–10 are untouched (`readInFlow` false → `sentence`).

## 2026-10: reading-speed gate (40 wpm from level 9)

`AnswerEvent.durationMs` = the voice note's length (media_details
.duration_ms, threaded processor → processAnswer `audio_duration_ms` →
the event). `sentenceArgs(context, event)` hands every sentence guard the
words, the per-engine transcripts, that duration and `minWpm` =
`MIN_READ_WPM` (40) when `context.level >= READ_SPEED_GATE_FROM_LEVEL` (9),
else null — level 8 and level-less snapshots have no gate. `assessSentence`
then fails a read slower than the floor (`tooSlow`), so it falls through to
the same wrong-read branches as an inaccurate read: no teachable word (every
word was right) → `sentence-sentence-wrong-retry`, a second slow read →
`sentence-sentence-complete-maxErrors`. Never a `…-correct-first` stid, so
sentence-band progression cannot promote on it (and two failed lessons
decrement, by decision). A missing / zero duration skips the gate.

## 2026-10: flawed-word cap

`assessSentence` also fails a read when more than `FLAWED_WORD_RATIO_MAX`
(30 %, inclusive) of the words were read with anything wrong: a 'close'
word (one akshara off) counts toward this cap only; a substituted /
omitted / transposed word toward both this cap and the 10 % error budget
(`flawedWordCount` on the assessment). Same wrong-read branches as before.

## 2026-10: ASER items (aser/aser.prompt.md)

- Input/context gained `letterOnly` (an ASER letter item: `word` is the
  letter, `wrongLetters = [letter]`, initial stid
  `${letter}-word-routeWrongLetter-drillLetters`, the start router goes to
  `routeWrongLetter`) and `aser` (opaque test state, carried, never read).
  When a letter item's drill returns to `word`, an eventless transition
  completes the lesson with `aser-letter-complete-correct|incorrect` (by
  answerCorrect); pending scores ride through. Old snapshots rehydrate with
  undefined for both (= off).
- Sentence guards pass `maxErrors = 3` at passage levels 9 and 10
  (`FLAT_READ_ERROR_BUDGET`) instead of the 10% budget; the flawed-word cap
  and speed gate are unchanged.
