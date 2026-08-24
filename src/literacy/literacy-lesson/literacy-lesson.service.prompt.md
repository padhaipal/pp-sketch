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

10.) Build `stateTransitionIds`: if `isStaleRestart` is true, prepend `STALE_LESSON_RESTART_STATE_TRANSITION_ID` before the snapshot's `stateTransitionId`; otherwise the array contains only the snapshot's `stateTransitionId`. Return `{ stateTransitionIds, isComplete: snapshot.status === 'done' }`.

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

2.) **Determine max word length.** In pseudocode:

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

## 2026-07: passages, comprehension, new level thresholds

- MAX_LESSON_LEVEL restored to 12. Level ≥ 8 selects a random ready reading
  passage (media_details.role='passage', media_details.level = level) instead
  of random word-list sentences; recently-lessoned passages (last 10) are
  excluded; falls back to nearest level, then to a level-7 word lesson.
- Sentence-band progression (base ≥ 8, 2026-08 two-lesson signal): judged on
  the last TWO completed lessons inside the 18-row scan window. A lesson =
  a group of consecutive rows ending in a `snapshot->>'status' = 'done'` row
  (the done row plus everything after the previous done row; group id = the
  reverse running done-count over `created_at DESC`). Per-lesson booleans
  from `snapshot->'context'->>'stateTransitionId'`: `first_try_pass` (a row
  ending `-sentence-comprehension-correct-first`), `entered_image` (a row
  ending `-letter-image-wrong` — the only entry into the image tier of the
  drill loop), `failed_out` (the done row is exactly
  `sentence-sentence-complete-maxErrors`). Decision, BOTH lessons required
  for every rule: both first-try-pass → +1; else both entered-image → −1;
  else both failed-out → −1; else hold. Fewer than two completed lessons in
  the window → hold. Mixed decrement evidence (image in one, failed-out in
  the other) does NOT combine. Emitted as one SQL round trip
  (`lesson_groups`/`lesson_flags` CTEs → `done_lesson_count` +
  `both_*` BOOL_ANDs); span attrs `pp.lesson.sentence.both_first_try_pass` /
  `both_entered_image` / `both_failed_out`. Moves stay capped at ±1 per
  selection by construction. Word-band logic (≤7) unchanged; keep-window is
  explicitly bounded at 15 rows (`rn <= $6`).
- literacy_lesson_states gained `passage_id` (FK → media_metadata, persisted
  from snapshot.context.passageId); `word` is nullable (CHECK word OR
  passage_id).
- `processAnswer` accepts `comprehension_answer_id` (nfm_reply option id):
  bypasses staleness, validates the id belongs to the current lesson's
  passage (JOIN option → question → passage), sends COMPREHENSION_ANSWER,
  persists answer/answer_correct/level/passage_id, returns the
  `${answerId}-comprehension-complete` stid. Invalid/mistimed answers return
  `{ignored: true}` and persist nothing.
