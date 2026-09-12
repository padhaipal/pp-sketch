# test-results.service.ts — nightly literacy-test results

Entity service for `test_runs`, `test_results_student` and
`test_results_geo_entity` (migration `1788000000000-CreateTestResults`; every
write to those tables is here). Run by the `test-results` BullMQ queue
(test-results.processor.ts) at 18:45 UTC = 00:15 IST, or manually via
`POST /admin/test-results/run?full=` (test-results.controller.ts).

## Why sums, not averages

`test_results_geo_entity` stores, per metric, `n`, `sum`, `sumsq`, `pass`
and an exact histogram (`nipun_*_hist` 5 bins, `mpl_b_hist` 21 — the score
space is discrete, see literacy-test-scores.prompt.md). These roll up
additively: a block's vector is the element-wise sum of its schools'. An
average cannot be summed; the histogram yields exact mean, sd, median, any
percentile and any pass threshold without reading student rows.

## run({ full, now? })

1. `computed_for` = the IST calendar date at run start (`istDateIso(now)`):
   the nightly row dated D summarises everything through 00:15 IST on D; a
   daytime manual run overwrites today's rows via the UNIQUE upserts.
2. Overlap guard: a `test_runs` row with `status = 'running'` started less
   than `STALE_RUN_HOURS` (6) ago → `TestRunInProgressError` (the processor
   logs and drops; the controller answers 409). Older running rows are
   crashed runs and are ignored.
3. Insert the `test_runs` row (`running`).
4. Candidates: `role = 'student' AND deleted_at IS NULL` with a
   `literacy_lesson_states` row newer than the student's latest
   `test_results_student.created_at` (or no row yet). NOT "activity since
   midnight" — a student missed by a failed night is picked up the next
   night. `full: true` takes everyone (after a retroactive passage edit).
5. Batches of `STUDENT_BATCH_SIZE` (200) → `computeLatestLiteracyTestScores`
   → one multi-row `INSERT … ON CONFLICT (student_id, computed_for) DO UPDATE`
   (scores, attempts, `geo_entity_id` = the referrer's geo entity at compute
   time, `created_at = now()`).
6. Geo: `DISTINCT ON (student_id) … ORDER BY student_id, created_at DESC`
   over ALL students' rows (most were skipped in step 5, so tonight's rows
   alone would give wrong totals), joined to the referrer's CURRENT
   `geo_entity_id`. Students whose direct referrer has no geo entity
   (referred by another student) appear in no geo row — by decision.
   `studentVector(row, computed_for)`: `students_active` = a lesson row in
   the last `ACTIVE_WINDOW_DAYS` (14); `students_scored` = any non-null
   score; unbanded (null birth_year) → `students_unbanded`, no metric
   contribution; per metric, a scored student inside that metric's age band
   (age-bands.ts) contributes n=1, sum, sumsq, pass, hist[score × denominator].
7. Roll-up: for each school with ≥1 student, `GeoEntityService.ancestors`
   once (cached per school), and the student's vector is added to the school
   and every ancestor — so an ancestor's vector is exactly the sum of its
   descendant schools', without re-reading student rows above school level.
   Rows are written only for entities on an ancestor path of a school that
   has students. Upsert on `(geo_entity_id, computed_for)` in batches of
   `GEO_BATCH_SIZE`.
8. Finish the `test_runs` row (`ok` + counts). Any exception → `failed`,
   `error` set, rethrown.

## enqueue(full)

Mirrors MirrorService.enqueue: `already-running` while `isRunning()` or a
manual job (`jobId` `test-results-manual`) is waiting/active; otherwise adds
the job. `attempts: 1` in queues.ts — a failed night is never retried into
an overlapping run.
