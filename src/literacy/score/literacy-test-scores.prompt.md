# literacy-test-scores.ts — shared literacy test-score algorithm

The digital-proxy literacy tests (NIPUN grades 1/2/3, MPL-B),
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

## NIPUN grade 1 — level-8 lesson reads (2026-10)

Grade 1 is not a comprehension test: level-8 passages (<10 words) end the
lesson on the read (literacy-lesson.machine.ts `SENTENCE_COMPLETE_LEVEL`).
`LEVEL8_LESSONS_SQL` (`literacy-test-scores:level-eight-lessons`) selects every
finished (`snapshot->>'status' = 'done'`) passage lesson whose done row's
stid contains `-sentence-complete-` — `…-sentence-complete-correct-first`
(first read right → `first_try`), `…-correct-retry` or
`sentence-sentence-complete-maxErrors` (fail) — with the passage's level
(`snapshot.context.level`, falling back to `media_details.level`). Lessons
from before 2026-08-26 (#69) ended on a comprehension tap and are not
selected: nothing before the change counts, by decision. No `rolled_back`
filter on the passage join, like the comprehension query.
`fetchLevel8Lessons` → `lessonsToAttempts` turns each lesson into a
`FirstAttempt` (the lesson row id as `question_id`, the completing voice
note as `message_id`, `question_type` null) so the pool/snapshot/series
machinery and the student modal's id lists work unchanged. `metricPools`,
`scoresFromAttempts` and `latestScoresFromAttempts` take the lessons as a
second argument (default empty); both `compute*` entry points run the two
queries. Pool: level 8 only; snapshot = `nipunSnapshot(pool, 4)`; the
response key is `nipun_grade_1`.

## Rules

- Only a student's FIRST attempt per question counts (`dedupeFirstAttempts`,
  chronological). Level-13 questions never qualify.
- Pools (`metricPools`): nipun_g1 = level-8 lesson reads (above); nipun_g2
  = level 10 × R1.1/R1.2/R1.3; nipun_g3 = level 11/12 × R1.x; mpl_b =
  level 11/12, any type.
- `nipunSnapshot(pool, 4)`: the 4 most recent → correct/4.
- `mplBSnapshot(pool)`: four filters most-recent-first — <20 → null; one per
  distinct type until 4 types (<4 → null); batch quotas R1.x ×5, R2.x ×5,
  R3.x ×1; fill to 20 → correct/20.
- Pass: NIPUN ≥ `NIPUN_PASS_THRESHOLD` 0.75 (three of four right — 2026-10, was strictly > 0.8 = all four), MPL-B STRICTLY > `MPL_B_PASS_THRESHOLD` 0.5 (11/20 up; was > 0.5 for both before 2026-10); `test_results_*` rows written before the change keep the old flags until recomputed (a `full` nightly run redoes every student's latest row and the geo vectors for that date; earlier dates stay as they were).
- `snapshotSeries` replays the snapshot over every prefix (history[] +
  latest) — what GET /users/:id/literacy-test-scores returns
  (`scoresFromAttempts` / `computeLiteracyTestScores`). Each snapshot also
  returns `selected` (the attempts it scored), and the series adds
  `counted_message_ids`: the tap ids (`FirstAttempt.message_id` =
  `literacy_lesson_states.user_message_id`, selected by the comprehension
  query) behind the latest and the previous history point — or, while
  insufficient, every attempt in the pool — so the student modal can list
  just the interactions that count toward that test.
- `snapshotLatest` is the series' last element in O(n) (one snapshot over
  the whole pool; a snapshot only turns null by losing rows, which prefixes
  never do). `latestScoresFromAttempts` / `computeLatestLiteracyTestScores`
  flatten it to `{score, passed, attempts}` per metric for the nightly job.

Because NIPUN always divides by 4 and MPL-B by 20, the score space is
discrete (5 and 21 values) — the geo histograms in test_results_geo_entity
are exact, not bucketed.
- `bin_message_ids` (2026-10): every tap in the test's pool (all first attempts), chronological — the student modal lists the whole bin and marks the `counted_message_ids` ones.
- `counted_message_ids` (2026-10 revision): the CURRENT score's attempts only — 4 for NIPUN, 20 for MPL-B (the union with the previous score's gave 5 / 21).
