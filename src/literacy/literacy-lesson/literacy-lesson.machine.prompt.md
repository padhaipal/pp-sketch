
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
