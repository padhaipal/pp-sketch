// pp-sketch/src/literacy/literacy-lesson/literacy-lesson.service.prompt.md
See src/docs/database.md for redis/database details and fallback patterns.

Wraps the pure XState machine (literacy-lesson.machine.ts) with persistence and lifecycle management. The machine handles state transitions; this service handles I/O (DB reads/writes, word selection).

## DB access pattern
Uses TypeORM Repository API (`@InjectRepository(LiteracyLessonStateEntity)`) for simple reads (findCurrentState).
Uses raw SQL via `DataSource.query()` for:
- `processAnswer` step 8: INSERT...SELECT with rolled_back guard on media_metadata
- `selectNextWord`: multi-CTE query (recent words, scores, word length logic)
Do NOT use `DataSource.query()` for simple reads — use the Repository.

## processAnswer(options: ProcessAnswerOptions): Promise\<ProcessAnswerResult>

The main entry point called by the inbound processor at step 7. Handles the full lesson interaction cycle: find-or-create state, run the machine, persist, return result.

1.) Validate options at runtime with `validateProcessAnswerOptions()`. If it fails, let the `BadRequestException` propagate.

2.) If `options.transcripts` is provided and non-empty, extract the `.text` field from each transcript entity and concatenate them into one string with spaces at the joins (`combinedTranscript`). If `options.transcripts` is undefined or empty, set `combinedTranscript = undefined`.

3.) Call `findCurrentState(options.user.id)` to get the current lesson state from the database.

4.) Determine whether to start fresh or continue. Also track whether this is a stale restart (`isStaleRestart`):
* If `findCurrentState` returned null → start a new lesson (step 5).
* If `created_at` is older than 15 minutes → start a new lesson (step 5). Do NOT set `isStaleRestart` (the student has been away too long for the nudge to make sense).
* If `created_at` is older than 60 seconds → start a new lesson (step 5). Set `isStaleRestart = true`.
* If `snapshot.status === 'done'` → start a new lesson (step 5).
* Else → rehydrate and run (step 6).

5.) Start a new lesson:
* Call `selectNextWord(options.user.id)` to pick the word.
* Create a new XState actor from the machine with `input: { word, userMessageId: options.user_message_id }`.
* Start the actor. The machine enters the `word` state and the initial context is set (including its `stateTransitionId`).
* If `combinedTranscript` is defined, send the ANSWER event: `{ type: 'ANSWER', studentAnswer: combinedTranscript }`.
* Extract the snapshot.
* Go to step 7.

6.) Rehydrate and run:
* If `combinedTranscript` is undefined, throw BadRequestException — rehydrating an existing lesson requires a student answer.
* Create a new XState actor from the machine, restoring from the stored `state.snapshot` (using XState's `createActor(machine, { snapshot: state.snapshot })`).
* Start the actor.
* Override `userMessageId` in the restored snapshot before creating the actor: `createActor(machine, { snapshot: { ...state.snapshot, context: { ...state.snapshot.context, userMessageId: options.user_message_id } } })`. Do not mutate context after creation — XState context is immutable outside the machine.
* Send the ANSWER event: `{ type: 'ANSWER', studentAnswer: combinedTranscript }`.
* Extract the new snapshot.
* Go to step 7.

7.) Read pending scores from the snapshot:
* Read `snapshot.context.pendingCorrect` and `snapshot.context.pendingIncorrect` from the snapshot and store them in local variables. The machine clears these arrays at the start of every ANSWER transition via the `clearPendingScores` action, so stale values never persist across calls.

8.) Persist the snapshot:
* Single DB round-trip. The INSERT atomically checks `rolled_back = false` on the referenced media_metadata row:
  ```sql
  INSERT INTO literacy_lesson_states (user_id, user_message_id, word, snapshot, created_at)
  SELECT $1, $2, $3, $4, now()
  FROM media_metadata m
  WHERE m.id = $2 AND m.rolled_back = false
  RETURNING *
  ```
  Where `$3` is `snapshot.context.word` (denormalized for easy querying).
  If the media has been rolled back, the SELECT returns nothing and no row is inserted.
* If zero rows were returned, it means the media was rolled back or the DB write failed — log WARN and throw (the processor must not send the outbound message).

9.) Record scores via ScoreService:
* If `pendingCorrect` or `pendingIncorrect` is non-empty, call `scoreService.gradeAndRecord()` with:
  * user: `options.user`
  * correct: `pendingCorrect` (omit if empty)
  * incorrect: `pendingIncorrect` (omit if empty)
  * userMessageId: `options.user_message_id`
* Await the result. If `gradeAndRecord()` throws, log WARN but do NOT re-throw — a scoring failure must not prevent the outbound message from being sent to the student.
* The result's `floored` graphemes (wrong answers that hit ScoreService's `MIN_SCORE` -10 floor — reported every time, including while pinned there) each become a `${grapheme}-${LETTER_SCORE_FLOOR_STID_SUFFIX}` (`…-letter-score-floor`) stid, appended at the END of this turn's `stateTransitionIds` in step 10. The machine penalises one letter per turn, so at most one. Media for it is per letter — a column of the /media-metadata coverage grid. On a scoring failure nothing is appended.

10.) Build `stateTransitionIds`: if `isStaleRestart` is true, prepend `STALE_LESSON_RESTART_STATE_TRANSITION_ID` before the snapshot's `stateTransitionId`; otherwise the array contains only the snapshot's `stateTransitionId`. Then append the floor stids from step 9. Return `{ stateTransitionIds, isComplete: snapshot.status === 'done' }`.

## findCurrentState(userId: string): Promise\<LiteracyLessonState | null>

Single DB round-trip. Returns the most recent lesson state for the given user.
`SELECT * FROM literacy_lesson_states WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`.
Uses the `(user_id, created_at DESC)` index for efficient lookup.
Returns null if no rows exist.

## cleanupPartialState(userMessageId: string): Promise\<void>

Called by the inbound processor on BullMQ retries (`job.attemptsMade > 0`) to wipe any partial DB writes from a prior attempt on the same `user_message_id`, so `processAnswer` can run against a clean slate.

Two raw-SQL DELETEs wrapped in a single `DataSource.transaction(async (manager) => ...)` so cleanup is atomic — if the second DELETE throws, the first rolls back and the next retry (or this attempt's failure handler) sees untouched state rather than a half-cleaned user_message_id. Both DELETEs are filtered by `user_message_id` and use `RETURNING id` so we can count what was removed:
1. `DELETE FROM scores WHERE user_message_id = $1 RETURNING id`
2. `DELETE FROM literacy_lesson_states WHERE user_message_id = $1 RETURNING id`

Order between the two DELETEs is immaterial — neither table has an FK to the other. Both reference `media_metadata.id`, which is not touched here (audio + transcripts are reusable across retries).

Log one INFO line with `user_message_id`, `scores_deleted`, and `lesson_states_deleted` counts so retries are observable. Log only after the transaction commits. No return value.

## selectNextWord(userId: string): Promise\<string>

Private helper. Selects the next word for a new lesson based on the student's score history and recent performance. The word list is co-located with the service at `src/literacy/literacy-lesson/word-list.json`. Load it with `path.join(__dirname, 'word-list.json')`.

### Constants (top of file)

```typescript
const RECENT_WORDS_TO_EXCLUDE = 5;
const SNAPSHOT_WORDS_TO_COUNT = 3;
const SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH = 10;
const SNAPSHOT_THRESHOLD_KEEP_WORD_LENGTH_SAME = 15;
const MIN_WORD_LENGTH_FLOOR = 2;
const NEW_USER_THRESHOLD = 3;
```

### Word length

Use `Array.from(word).length` throughout — consistent with how the machine decomposes words via `Array.from(context.word)` (each code point, including matras, counts as one character).

### Algorithm

1.) **Single DB round-trip.** Fetch letter scores, recent words, snapshot count, and distinct-word count in one query.

2.) **Determine max word length.** SUPERSEDED — see "2026-11: one level per
lesson" at the end of this file for the current rule (no new-user floor, no
accelerator). The original pseudocode:

```
if distinct_word_count < NEW_USER_THRESHOLD:
    maxLength = MIN_WORD_LENGTH_FLOOR
else:
    mostRecentWordLen = grapheme_length(recent_words[0])
    if top_n_snapshot_count < SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH:
        maxLength = mostRecentWordLen + 1
    elif top_n_snapshot_count < SNAPSHOT_THRESHOLD_KEEP_WORD_LENGTH_SAME:
        maxLength = mostRecentWordLen
    else:
        maxLength = mostRecentWordLen - 1
maxLength = max(maxLength, MIN_WORD_LENGTH_FLOOR)
```

The floor ensures one- and two-character words are never removed by the length rule.

3.) **Filter candidates.** In pseudocode:

```
candidates = [w for w in wordList
              if grapheme_length(w) <= maxLength
              and w not in recent_words]
```

This enforces the max-length rule and avoids repeating any of the last `RECENT_WORDS_TO_EXCLUDE` distinct words, so the student doesn't see the same word too many times in a row.

4.) **Score each remaining word.** For each candidate, add up the scores of all its letters. If a letter has no recorded score, use `-100` as the default (this shouldn't happen in practice, but serves as a defensive fallback).

5.) **Select the lowest-scored word.** Find the minimum word score among candidates. If multiple words tie, pick one at random.

6.) **Safety fallback.** If the filtered list is empty (should not happen given the word list size), fall back to a random two-letter word from the full word list and log a WARN.

7.) Return the selected word.

## MAX_LESSON_LEVEL_CAP — ops-toggleable level ceiling (2026-08)

Env var `MAX_LESSON_LEVEL_CAP` (integer). When set to a value in
`[MIN_WORD_LENGTH_FLOOR, MAX_LESSON_LEVEL]`, `effectiveMaxLessonLevel()`
applies it in selectNextString as a final `Math.min` clamp AFTER the ratchet
base and the MAX_LESSON_LEVEL clamp. Unset, non-numeric, or out-of-range
means no extra cap. Read per selection (Railway redeploys on variable change,
so no restart step; specs toggle `process.env` directly).

Setting it to 7 reproduces the 2026-08 TEMP level-7 cap (#65, reverted in
#72): every student is brought into the word band — ONE level per lesson
since 2026-11 (a level-10 student goes 9, 8, 7 over three lessons, reading
passages on the way down), not all at once; NOTHING else is disabled — the
sentence machine states, selectPassage, computeSentenceBandSignal,
comprehension handling, and passage generation/gates are all live and, once
a student is at the cap, simply unreachable from selection. Mid-lesson students continue at their stored
level (continue path skips selection), so completedReading at 8+ still
fires (see "completedReading" below). While capped, new lesson rows are written at the capped level, so
prev_level ratchets down; on lifting the cap students re-climb one level per
lesson by the normal rules.

TOGGLE: set/unset the Railway variable. No code change in either direction.

## 2026-07: passages, comprehension, new level thresholds

- MAX_LESSON_LEVEL restored to 12. Level ≥ 8 selects a random ready reading
  passage (media_details.role='passage', media_details.level = level) instead
  of random word-list sentences. **A student never sees a passage twice while
  any unseen one exists** (2026-09; was "last 10 excluded"): the selection
  SQL ships every passage id in the student's history
  (`RECENT_PASSAGES_TO_EXCLUDE = 10_000_000`, newest first) and
  `selectPassage` walks (2026-11 — the student's OWN level only, see the
  section at the end): (1) exact level, unseen → (2) exact level,
  least-recently-seen first (`ORDER BY array_position($2, id) DESC`). Step 2
  returns `reused: true` → span `pp.lesson.passage.reused` + a warn
  ("level N passages exhausted … reusing") — the signal to seed more at that
  level. A level with no ready passage at all gets a level-7 word lesson and
  the student keeps their level. "Seen" = any literacy_lesson_states row with
  that passage_id (assigned, not necessarily completed).
- Sentence-band progression (base ≥ 8, 2026-08): the single round-trip SQL
  ships only the raw inputs — `recent_turns` (json_agg of {rn, is_done,
  stid} over the 18-row window, newest first) and `lifetime_done_count`
  (all-time done rows). Lesson grouping, validity (an unbounded oldest
  group clipped by the window is ignored, never scored), the per-lesson
  booleans, and the 6-rule decision (both-first-try +1; churn decrement
  when done-in-window < 3 with lifetime ≥ 3 — outranked by rule 1, gated
  off for new students; <2 valid lessons hold; both-image −1; both-failed
  −1, never combined; else hold) all live in the pure
  `computeSentenceBandSignal` — see sentence-band-signal.utils.prompt.md.
  That module also owns SENTENCE_RECENT_ROWS_WINDOW. Span attrs:
  `pp.lesson.sentence.both_first_try_pass` / `both_entered_image` /
  `both_failed_out` / `done_in_window` / `low_completion_decrement`. Moves
  stay capped at ±1 per selection by construction. Word-band logic (≤7)
  unchanged; keep-window is explicitly bounded at 15 rows (`rn <= $6`).
- literacy_lesson_states gained `passage_id` (FK → media_metadata, persisted
  from snapshot.context.passageId); `word` is nullable (CHECK word OR
  passage_id).
- `processAnswer` accepts `comprehension_answer_id` (nfm_reply option id):
  bypasses staleness, validates the id belongs to the current lesson's
  passage (JOIN option → question → passage), sends COMPREHENSION_ANSWER,
  persists answer/answer_correct/level/passage_id, returns the
  `${answerId}-comprehension-complete` stid. Invalid/mistimed answers return
  `{ignored: true}` and persist nothing.
- 2026-09: the tap returns TWO stids — the machine's
  `${answerId}-comprehension-complete` (explanation media, identical for a
  right and a wrong tap) followed by the fixed `comprehension-answer-correct`
  or `comprehension-answer-incorrect`
  (`COMPREHENSION_ANSWER_{CORRECT,INCORRECT}_STATE_TRANSITION_ID`), chosen
  from the `answerCorrect` already resolved for the event — no extra read.
  Right/wrong feedback (a sticker) is seeded once under the fixed stid: a
  per-option row is impractical and the `_` generic key cannot match a
  UUID-prefixed stid. Returned only — the persisted snapshot keeps the
  machine's stid (sentence-band progression reads it back). An unseeded
  outcome stid sends nothing. The processor needs no change: result1's stids
  precede the chained lesson's, so the order is explanation → outcome media →
  next lesson → flow last.

## completedReading — reading-speed hook gate (2026-09)

`ProcessAnswerResult.completedReading` fires when THIS voice turn was a
CORRECT passage read at level > SENTENCE_LEVEL_THRESHOLD, independent of
lesson completion: stid matches `CORRECT_PASSAGE_READ_STID_RE`
(`…-sentence-{complete|comprehension}-correct-{first|retry}`) AND
`answerCorrect === true` AND a sentence is in context. Before 2026-09 it was
gated on `snapshot.status === 'done'`, which only level 8 reaches on the read
turn (9+ go to `comprehension` and complete on the flow tap, where no audio
duration exists) — so wpm stids only ever fired for level 8, and also
misfired on `sentence-sentence-complete-maxErrors` (failed second read).
The answerCorrect check exists because the comprehension state's voice-note
nudge re-emits `…-sentence-comprehension-correct-retry` with answerCorrect
null.

## 2026-09: level 11+ read-in-flow

- `PASSAGE_FLOW_LEVEL_THRESHOLD = 11`. selectNextString is unchanged; the
  machine input gets `readInFlow: passageId != null && lesson.level >= 11`
  (student's level; since 2026-11 the passage is always at that level).
- `ProcessAnswerResult.flowPassageText`: set whenever the snapshot sits in
  `comprehension` with `readInFlow` (initial send and the voice-note nudge);
  the passage row's RAW text (tokenized join as fallback). `sentenceText` is
  never set in that mode — the passage is not a plain text message.
- Staleness: a snapshot whose stid ends `-passage-comprehension-initial` gets
  the long 4 min 58 s window like the read-aloud states (reading the passage
  inside the flow takes as long).
- Progression: `recent_turns` now also ships `answer_correct`; see
  sentence-band-signal.utils.prompt.md — a flow-mode lesson counts as a
  first-try pass when the tapped option was correct and as failed-out when it
  was wrong, so both-correct → +1 (cap 12) and both-wrong → −1 (12 → 11 → 10
  puts the student back on read-aloud lessons).

## 2026-10: reading-speed gate

`processAnswer` forwards `audio_duration_ms` to the machine as the ANSWER
event's `durationMs`; the inbound processor reads it off the audio entity
before the call (the same value it already used for the wpm stid). The
gate itself is `MIN_READ_WPM` in sentence-assessment.ts, applied from
level 9 (literacy-lesson.machine.ts `READ_SPEED_GATE_FROM_LEVEL`).

## 2026-10: ASER test delivery (aser/aser.prompt.md)

- Fresh start asks `AserService.planFreshLesson(userId, latest row's
  context.aser)`: an ASER item (machine input + `aser`, row `level` NULL) or
  a normal selection, with `forcedLevel` = the onboarding run's placement
  for the lesson right after it. No stids are added — ASER uses the lesson
  loop's own. AserService is `@Optional()` only for legacy unit specs.
- Continue path: when the latest row is mid-test, `applyAserTurn` updates
  `context.aser` on a JSON copy of the snapshot before the INSERT (from
  this turn's answer, and for the letter test the change in the machine's
  `aserLetters` counts and the asked letter `wrongLetters[0]`). Comprehension
  taps carry `aser` unchanged.
- selectNextString: ASER rows excluded from recent_rows and
  lifetime_done_count; every student is held at the base while
  recent_rows < 8 (2026-11 — was an ASER-only hold, others dropped to the
  level-2 new-user floor); `forcedLevel` overrides the computed cap (then the
  floor/ceiling clamps; it is exempt from the one-step clamp).
- completedReading uses the passage level when the row has no selected
  level (ASER rows).
- `splitLessonWords` moved to lesson-words.utils.ts (shared with AserService).

## 2026-11: one level per lesson; passages from the student's own level only

A new lesson's level is at most ONE level away from the previous lesson's
level, up or down (`MAX_LEVEL_STEP = 1`).

Removed:

- The new-user gate (`NEW_USER_THRESHOLD`; `distinct_word_count < 3` or
  `recent_row_count < 8` → level 2) and the "recent_words empty → level 2"
  branch. Every new student is placed by the onboarding ASER test
  (`forcedLevel`), so level 2 is no longer an initial placement; it remains
  only as the minimum level (`MIN_WORD_LENGTH_FLOOR`).
- The fast-find accelerator (+3: `LEVEL_BOOST_WINDOW`,
  `LEVEL_BOOST_INCREMENT`, `FIRST_WORD_ROW_COUNT`, `SECOND_WORD_ROW_COUNT`,
  `unique_in_boost_window`, span `pp.lesson.word.accelerated`) and the
  "entering the passage band lands on 8" clamp that only existed for it.
- SQL columns `distinct_word_count` and `has_aser_placement`. Query params
  are now $1 user, $2 recent words, $3 row window, $4 add window, $5 keep
  window, $6 passage history.

Word band (base ≤ 7):

```
if recent_row_count < 8:          maxLength = base        # too little history
elif unique_in_add_window >= 3:   maxLength = base + 1
elif unique_in_keep_window >= 3:  maxLength = base
else:                             maxLength = base - 1
```

Sentence band (base ≥ 8): unchanged, already ±1 (computeSentenceBandSignal).

After the floor / MAX_LESSON_LEVEL / MAX_LESSON_LEVEL_CAP clamps, the result
is clamped to `[base − 1, base + 1]` whenever there is a previous level
(stored `prev_level`, or cold-state the last word's own level) and no
`forcedLevel`. Applied LAST, so the env cap also moves a student one level per
lesson. The onboarding ASER placement is the one selection not measured
against a previous level — it is the student's first lesson.

Passages: `selectPassage` serves only passages at the student's level —
unseen first, then (level exhausted for this student) the least recently seen
one again. It never borrows from another level. When the level has no ready
passage at all, the student gets a level-7 word lesson and the row still
records their level (`passage-missing-word-fallback`), so they return to
passages as soon as that level is seeded; before, the row recorded 7.
