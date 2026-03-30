// pp-sketch/src/literacy/literacy-lesson/literacy-lesson.service.prompt.md
See src/docs/database.md for redis/database details and fallback patterns.

Wraps the pure XState machine (literacy-lesson.machine.ts) with persistence and lifecycle management. The machine handles state transitions; this service handles I/O (DB reads/writes, word selection).

## processAnswer(options: ProcessAnswerOptions): Promise\<ProcessAnswerResult>

The main entry point called by the inbound processor at step 7. Handles the full lesson interaction cycle: find-or-create state, run the machine, persist, return result.

1.) Validate options at runtime with `validateProcessAnswerOptions()`. If it fails, let the `BadRequestException` propagate.

2.) If `options.transcripts` is provided and non-empty, extract the `.text` field from each transcript entity and concatenate them into one string with spaces at the joins (`combinedTranscript`). If `options.transcripts` is undefined or empty, set `combinedTranscript = undefined`.

3.) Call `findCurrentState(options.user.id)` to get the current lesson state from the database.

4.) Determine whether to start fresh or continue:
* If `findCurrentState` returned null → start a new lesson (step 5).
* If `created_at` is older than 60 seconds → start a new lesson (step 5).
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
* Before sending the event, update the actor's context with the new `userMessageId`: assign `context.userMessageId = options.user_message_id`.
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

10.) Return `{ stateTransitionId: snapshot.context.stateTransitionId, isComplete: snapshot.status === 'done' }`.

## findCurrentState(userId: string): Promise\<LiteracyLessonState | null>

Single DB round-trip. Returns the most recent lesson state for the given user.
`SELECT * FROM literacy_lesson_states WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`.
Uses the `(user_id, created_at DESC)` index for efficient lookup.
Returns null if no rows exist.

## selectNextWord(userId: string): Promise\<string>

Private helper. Selects the next word for a new lesson based on the student's score history and recent performance. The word list is loaded from `./word-list.json`.

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

1.) **Single DB round-trip.** Fetch letter scores, recent words, snapshot count, and distinct-word count in one query:

```sql
WITH recent_distinct_words AS (
  SELECT word, MAX(created_at) AS latest_at
  FROM literacy_lesson_states
  WHERE user_id = $1
  GROUP BY word
  ORDER BY latest_at DESC
  LIMIT $RECENT_WORDS_TO_EXCLUDE
),
top_n_words AS (
  SELECT word FROM recent_distinct_words
  ORDER BY latest_at DESC
  LIMIT $SNAPSHOT_WORDS_TO_COUNT
),
top_n_snapshot_count AS (
  SELECT COUNT(*)::int AS count
  FROM literacy_lesson_states
  WHERE user_id = $1 AND word IN (SELECT word FROM top_n_words)
),
latest_scores AS (
  SELECT DISTINCT ON (s.letter_id) l.grapheme, s.score
  FROM scores s
  JOIN letters l ON l.id = s.letter_id
  WHERE s.user_id = $1
  ORDER BY s.letter_id, s.created_at DESC
),
distinct_word_count AS (
  SELECT COUNT(DISTINCT word)::int AS count
  FROM literacy_lesson_states
  WHERE user_id = $1
)
SELECT
  COALESCE(
    (SELECT json_agg(json_build_object('grapheme', grapheme, 'score', score))
     FROM latest_scores),
    '[]'::json
  ) AS letter_scores,
  COALESCE(
    (SELECT json_agg(word ORDER BY latest_at DESC)
     FROM recent_distinct_words),
    '[]'::json
  ) AS recent_words,
  COALESCE((SELECT count FROM top_n_snapshot_count), 0) AS top_n_snapshot_count,
  COALESCE((SELECT count FROM distinct_word_count), 0) AS distinct_word_count
```

Returns a single row with:
* `letter_scores` — array of `{ grapheme, score }`, the latest score per letter for this user.
* `recent_words` — array of up to `RECENT_WORDS_TO_EXCLUDE` most recently covered distinct words (most recent first).
* `top_n_snapshot_count` — total number of `literacy_lesson_states` rows whose word matches one of the `SNAPSHOT_WORDS_TO_COUNT` most recent distinct words.
* `distinct_word_count` — total number of distinct words this user has ever been taught.

2.) Build a `Map<string, number>` from `letter_scores`, mapping each grapheme to its latest score.

3.) **Exclude recent words.** Remove every word that appears in `recent_words` from the word list.

4.) **Determine max word length:**

* If `distinct_word_count < NEW_USER_THRESHOLD` → `maxLength = MIN_WORD_LENGTH_FLOOR`.
* Otherwise, let `mostRecentWordLen = Array.from(recent_words[0]).length`:
  * If `top_n_snapshot_count < SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH` → `maxLength = mostRecentWordLen + 1`.
  * Else if `top_n_snapshot_count < SNAPSHOT_THRESHOLD_KEEP_WORD_LENGTH_SAME` → `maxLength = mostRecentWordLen`.
  * Else → `maxLength = mostRecentWordLen - 1`.
* Apply floor: `maxLength = Math.max(maxLength, MIN_WORD_LENGTH_FLOOR)` (one- and two-character words are never removed).

5.) **Filter by length.** Remove words where `Array.from(word).length > maxLength`.

6.) **Score each remaining word.** For each word, compute `wordScore = Array.from(word).reduce((sum, char) => sum + (scoreMap.get(char) ?? 0), 0)`.

7.) **Select the lowest-scored word.** Find the minimum `wordScore` among remaining words. If multiple words tie, pick one at random.

8.) **Safety fallback.** If the filtered list is empty (should not happen given the word list size), fall back to a random word from the full word list and log a WARN.

9.) Return the selected word.
