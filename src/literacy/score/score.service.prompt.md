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

## getLetterBins(users: string | string[], options?: { asOf?: Date }): Promise\<LetterBinsResult | LetterBinsResult[]>

Two database round-trips. Accepts one or more user identifiers (UUIDs or phone numbers, freely mixed) and returns every letter in the `letters` table bucketed into one of four disjoint, exhaustive bins per user:

- `untouched` — letter has 0–1 score rows for this user, OR has score rows
  but no seed (`user_message_id IS NULL`). Catches both "letter never seeded
  for this user" and "seeded but never practiced".
- `regressed` — `last_score <= seed_score` (got worse, or back to neutral
  after a dip).
- `learnt` — `last_score > seed_score` AND `n_scores >= 4` AND
  `min_score <= seed_score - 4`. Mirrors the previous `getLettersLearnt`
  rule (≥ 4 score rows, dipped ≥ 4 below seed, recovered above) — the
  "magic 4s" come from there as the source of truth.
- `improved` — `last_score > seed_score` but doesn't qualify for `learnt`
  (e.g. fewer than 4 score rows, or never dipped 4 below seed).

Input is `string | string[]`. A single string returns a single `LetterBinsResult`; an array returns `LetterBinsResult[]`. The `users` parameter is required. Each identifier is classified as a UUID (regex `^[0-9a-f-]{36}$`) or a phone number (everything else). Duplicate users are deduplicated; results preserve input order.

1.) Validate with `validateLetterBinsInput()` — normalises a bare string into a one-element array, rejects empty strings and non-string array items.

2.) **DB hit 1** — resolve all users in one query:
    `SELECT id, external_id FROM users WHERE id IN (...) OR external_id IN (...)`
    Throws `NotFoundException` for any identifier that doesn't match a row.

3.) **DB hit 2** — single CTE query that, per `(user, letter)`, computes
    `seed_score` (the row with `user_message_id IS NULL`), `last_score`
    (chronologically most recent), `min_score`, and `n_scores`. CROSS JOIN
    against the `letters` table guarantees a row even for letters with no
    scores for the user (those land in `untouched`).
    ```sql
    WITH per_letter AS (
      SELECT s.user_id, s.letter_id, s.score, s.user_message_id,
             ROW_NUMBER() OVER (
               PARTITION BY s.user_id, s.letter_id ORDER BY s.created_at DESC
             ) AS rn_last
      FROM scores s
      WHERE s.user_id = ANY($1::uuid[]) [AND s.created_at <= $asOf]
    ),
    agg AS (
      SELECT user_id, letter_id,
             COUNT(*) AS n_scores,
             MAX(score) FILTER (WHERE user_message_id IS NULL) AS seed_score,
             MAX(score) FILTER (WHERE rn_last = 1) AS last_score,
             MIN(score) AS min_score
      FROM per_letter
      GROUP BY user_id, letter_id
    )
    SELECT u.id AS user_id, l.grapheme,
           a.n_scores, a.seed_score, a.last_score, a.min_score
    FROM unnest($1::uuid[]) AS u(id)
    CROSS JOIN letters l
    LEFT JOIN agg a ON a.user_id = u.id AND a.letter_id = l.id;
    ```
    Optional `s.created_at <= $asOf` lets the morning-update report card
    compute snapshots ("as of yesterday IST midnight" vs "today IST midnight")
    for the yesterday-delta highlight.

4.) Bucket each row in priority order:
   - `seed_score IS NULL` OR `n_scores ≤ 1` → `untouched`
   - `last_score ≤ seed_score` → `regressed`
   - `n_scores ≥ 4 AND min_score ≤ seed_score - 4` → `learnt`
   - otherwise → `improved`

5.) Return `{ userId, userPhone, bins: { untouched, regressed, learnt, improved } }` (single object) or an array thereof.
