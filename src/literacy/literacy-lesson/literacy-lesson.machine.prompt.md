
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
