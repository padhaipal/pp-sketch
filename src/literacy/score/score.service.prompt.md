## DB access pattern
All queries use raw SQL via `DataSource.query()`. The score queries are complex (multi-table INSERT...SELECT with rolled_back guards, dynamic WHERE clauses, UNION ALL bulk inserts) and don't map cleanly to Repository API.

## create(options: CreateScoreOptions): Promise<Score>

Single database round-trip. Inserts a row into `scores` using `INSERT ... SELECT ... RETURNING *`.

Resolves user and letter via subquery regardless of how they were identified (entity, id, or external id). The subquery doubles as an existence check — if the referenced row doesn't exist, the insert returns nothing and the method throws `NotFoundException`.

The INSERT query atomically checks `rolled_back = false` on the referenced `media_metadata` row by joining it in the SELECT source: `INSERT INTO scores ... SELECT u.id, l.id, $user_message_id, $score FROM users u, letters l, media_metadata m WHERE ... AND m.id = $user_message_id AND m.rolled_back = false`. If the media has been rolled back, the SELECT returns nothing, the insert is a no-op, and the method throws `BadRequestException`.

## find(options: FindScoreOptions): Promise<Score[]>

Single database round-trip. Returns scores ordered by `created_at DESC`.

- User and/or letter filters are optional. When provided, resolved via subquery (same as `create`).
- `limit` defaults to `DEFAULT_FIND_SCORE_LIMIT` (100,000) when omitted. Must be a positive integer not exceeding `DEFAULT_FIND_SCORE_LIMIT`.
- Builds a single `SELECT ... FROM scores` query, conditionally adding `WHERE` clauses for user_id and/or letter_id, plus `ORDER BY created_at DESC` and `LIMIT`.

## gradeAndRecord(options: GradeAndRecordOptions): Promise\<Score[]>

Two database round-trips. Accepts correct/incorrect letter graphemes for a single user, recalculates scores, and persists them.

1.) Validate options at runtime with `validateGradeAndRecordOptions()`. This normalises `correct` and `incorrect` into `string[]` (wrapping a bare string in an array) and ensures at least one is provided. If validation fails, let the `BadRequestException` propagate.

2.) **DB hit 1** — call `find()` for this user (no letter filter, no limit override — uses the default). From the returned rows (already ordered by `created_at DESC`), extract the most recent score per `letter_id` by keeping only the first occurrence of each `letter_id`.

3.) From that map of latest-per-letter scores, remove every entry whose `score` value is an integer (`score % 1 === 0`). What remains is the set of "active" non-integer scores.

4.) Compute `average`: the arithmetic mean of all remaining non-integer score values. If no non-integer scores exist, use `0.001` as the default average.

5.) For each grapheme in `_correct` and `_incorrect`:
   - Look up the letter's previous score from the non-integer map built in step 3 (may be `undefined` if the letter had no prior non-integer score or no score at all).
   - Call `calculateNewScore(average, previousScore, isCorrect)` to obtain the new score value.

6.) **DB hit 2** — build and execute a single multi-row `INSERT INTO scores ... SELECT ... RETURNING *` that inserts one row per input grapheme. Resolves each user/letter via subquery (same pattern as `create()`). Each row includes `user_message_id` set to `options.userMessageId`. The SELECT source also joins `media_metadata m WHERE m.id = $userMessageId AND m.rolled_back = false` — if the media has been rolled back, the SELECT returns nothing and no rows are inserted. This keeps the write to a single round-trip regardless of how many letters were provided.

7.) If the INSERT returned zero rows and input graphemes were provided, it means the media was rolled back. Log WARN and return an empty array.

8.) Return the array of newly created `Score` rows.

### calculateNewScore(average: number, previousScore: number | undefined, correct: boolean): number

Private helper. Dummy implementation — will be replaced with the real adaptive algorithm later. Must reliably produce non-integer results.

```typescript
function calculateNewScore(
  average: number,
  previousScore: number | undefined,
  correct: boolean,
): number {
  const base = previousScore ?? 0;
  return correct ? base + 1.01 : base - 5.01;
}
```

## getLettersLearnt(users: string | string[]): Promise\<LettersLearntResult | LettersLearntResult[]>

Two database round-trips. Accepts one or more user identifiers (UUIDs or phone numbers, freely mixed) and returns which letters each user has "learnt".

Input is `string | string[]`. A single string returns a single `LettersLearntResult`; an array returns `LettersLearntResult[]`. The `users` parameter is required.

Each identifier is classified as a UUID (regex `^[0-9a-f-]{36}$`) or a phone number (everything else). Duplicate users (same user referenced by both id and phone) are deduplicated; results preserve input order.

1.) Validate with `validateLettersLearntInput()` — normalises a bare string into a one-element array, rejects empty strings and non-string array items.

2.) **DB hit 1** — resolve all users in one query:
    `SELECT id, external_id FROM users WHERE id IN (...) OR external_id IN (...)`
    Throws `NotFoundException` for any identifier that doesn't match a row.

3.) **DB hit 2** — fetch every score for the resolved users with letter graphemes:
    `SELECT s.user_id, s.score, l.grapheme FROM scores s JOIN letters l ON l.id = s.letter_id WHERE s.user_id IN (...) ORDER BY s.user_id, l.grapheme, s.created_at ASC`
    The `ORDER BY` groups rows by user → letter → chronological, so no in-memory sort is needed.

4.) Group scores into `Map<user_id, Map<grapheme, number[]>>` (score values only, already in chronological order).

5.) For each user, iterate over each letter's score series and apply the "learnt" heuristic:
   - **Skip** if the letter has fewer than 4 scores.
   - Let `firstScore = scores[0]` and `lastScore = scores[scores.length - 1]`.
   - **Skip** if `lastScore < firstScore` (overall regression).
   - Otherwise scan `scores[1..]`: if any value is ≤ `firstScore − 4`, the letter is learnt — add its grapheme to the result and move on.

6.) Return `{ userId, userPhone, lettersLearnt }` (single object) or an array thereof.
