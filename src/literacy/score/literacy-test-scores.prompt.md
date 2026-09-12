# literacy-test-scores.ts — shared literacy test-score algorithm

The digital-proxy literacy tests (NIPUN grade 2, NIPUN grade 3, MPL-B),
extracted from UserService.getLiteracyTestScores in 2026-09 so the nightly
test-results job (test-results.service.ts) can score many students with one
query. `literacy-test-scores.spec.ts` holds a golden JSON captured from the
pre-refactor implementation: the per-user output is byte-identical, and that
literal is never regenerated from the new code.

## Query

`COMPREHENSION_ANSWERS_SQL` (`user_id = ANY($1::uuid[])`): every
comprehension answer (`literacy_lesson_states` rows whose stid ends
`-comprehension-complete`, `answer_correct` non-null) joined option → question
→ passage for `question_type` and the passage's `media_details.level`. NO
`rolled_back` filter on the joins (2026-08): a retroactively culled passage
must not erase earned history. `fetchFirstAttempts(query, userIds)` runs it
once and returns a Map with an entry for EVERY requested id (empty list when
a user has no answers); a row without `user_id` is attributed to the single
requested user (legacy single-user fixtures), otherwise dropped.

## Rules

- Only a student's FIRST attempt per question counts (`dedupeFirstAttempts`,
  chronological). Level-13 questions never qualify.
- Pools (`metricPools`): nipun_g2 = level 10 × R1.1/R1.2/R1.3; nipun_g3 =
  level 11/12 × R1.x; mpl_b = level 11/12, any type.
- `nipunSnapshot(pool, 4)`: the 4 most recent → correct/4.
- `mplBSnapshot(pool)`: four filters most-recent-first — <20 → null; one per
  distinct type until 4 types (<4 → null); batch quotas R1.x ×5, R2.x ×5,
  R3.x ×1; fill to 20 → correct/20.
- Pass is STRICTLY > 0.5.
- `snapshotSeries` replays the snapshot over every prefix (history[] +
  latest) — what GET /users/:id/literacy-test-scores returns
  (`scoresFromAttempts` / `computeLiteracyTestScores`).
- `snapshotLatest` is the series' last element in O(n) (one snapshot over
  the whole pool; a snapshot only turns null by losing rows, which prefixes
  never do). `latestScoresFromAttempts` / `computeLatestLiteracyTestScores`
  flatten it to `{score, passed, attempts}` per metric for the nightly job.

Because NIPUN always divides by 4 and MPL-B by 20, the score space is
discrete (5 and 21 values) — the geo histograms in test_results_geo_entity
are exact, not bucketed.
