## create(options: CreateScoreOptions): Promise<Score>

Single database round-trip. Inserts a row into `scores` using `INSERT ... SELECT ... RETURNING *`.

Resolves user and letter via subquery regardless of how they were identified (entity, id, or external id). The subquery doubles as an existence check — if the referenced row doesn't exist, the insert returns nothing and the method throws `NotFoundException`.

## find(options: FindScoreOptions): Promise<Score[]>

Single database round-trip. Returns scores ordered by `created_at DESC`.

- User and/or letter filters are optional. When provided, resolved via subquery (same as `create`).
- `limit` defaults to `DEFAULT_FIND_SCORE_LIMIT` (100,000) when omitted. Must be a positive integer not exceeding `DEFAULT_FIND_SCORE_LIMIT`.
- Builds a single `SELECT ... FROM scores` query, conditionally adding `WHERE` clauses for user_id and/or letter_id, plus `ORDER BY created_at DESC` and `LIMIT`.
