## create(options: CreateScoreOptions): Promise<Score>

Single database round-trip. Inserts a row into `scores` using `INSERT ... SELECT ... RETURNING *`.

Resolves user and letter via subquery regardless of how they were identified (entity, id, or external id). The subquery doubles as an existence check — if the referenced row doesn't exist, the insert returns nothing and the method throws `NotFoundException`.

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

6.) **DB hit 2** — build and execute a single multi-row `INSERT INTO scores ... SELECT ... RETURNING *` that inserts one row per input grapheme. Resolves each user/letter via subquery (same pattern as `create()`). This keeps the write to a single round-trip regardless of how many letters were provided.

7.) Return the array of newly created `Score` rows.

### calculateNewScore(average: number, previousScore: number | undefined, correct: boolean): number

Private helper. Dummy implementation — will be replaced with the real adaptive algorithm later. Must reliably produce non-integer results.

```typescript
function calculateNewScore(
  average: number,
  previousScore: number | undefined,
  correct: boolean,
): number {
  const base = previousScore ?? average;
  const direction = correct ? 1 : -1;
  return base + direction * 0.1 + average * 0.01;
}
```