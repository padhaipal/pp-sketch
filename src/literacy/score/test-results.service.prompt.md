# test-results.service.ts — nightly literacy-test results

Entity service for `test_runs`, `test_results_student` and
`test_results_geo_entity` (migration `1788000000000-CreateTestResults`; every
write to those tables is here). Run by the `test-results` BullMQ queue
(test-results.processor.ts) at 18:45 UTC = 00:15 IST, or manually via
`POST /admin/test-results/run?full=` (test-results.controller.ts).

## NIPUN grade 1 (migration 1793000000000-AddNipunG1, 2026-10)

`TEST_METRICS = ['nipun_g1', 'nipun_g2', 'nipun_g3', 'mpl_b']`. Grade 1 is
the year below g2 (age band [6, 7)) and is scored by
literacy-test-scores.ts over the child's last four finished level-8
lessons (first-try read = correct; score passes/4, pass ≥ 0.75) — a second
query per batch (`literacy-test-scores:level-eight-lessons`) beside the
comprehension one. Same column shapes as g2/g3 (`nipun_g1_score/_passed/
_attempts` per student; `nipun_g1_n/_sum/_sumsq/_pass/_hist[5]` and
`nipun_g1_cohort` per area). No backfill: rows before the deploy keep
NULL scores and zero vectors; a student's g1 appears on their next
rescore.

## ASER (migration 1794000000000-AddAserMetrics, 2026-10)

Four tests, l1 letter / l2 word / l3 paragraph / l4 story
(literacy/aser/aser.prompt.md). Per batch, `computeAserTestScores` (one
`aser:rows` read) gives each test's latest FINISHED run that reached it:
`aser_lN_correct`, `_incorrect` (kept when undecided), `_passed` (NULL =
undecided) and `_at` (the answer that ended the run); all NULL when never
taken. Per area, `aser_lN_n` (students whose latest row has the test),
`_pass`, `_fail` — NO age band, every student with a geo counts — summed
up the tree like the other vectors (`AserCounts` in `GeoVector.aser`). The
usage backfill leaves them alone. ASER does not count towards
`students_scored`. No backfill: earlier rows stay NULL / 0.

## Why sums, not averages

`test_results_geo_entity` stores, per metric, `n`, `sum`, `sumsq`, `pass`
and an exact histogram (`nipun_*_hist` 5 bins, `mpl_b_hist` 21 — the score
space is discrete, see literacy-test-scores.prompt.md; `usage_hist` 31 —
whole minutes 0…29 and 30+).

## Usage — the leading indicator (migration 1790000000000-AddUsageMetric)

`METRICS = [...TEST_METRICS, 'usage']`. A student's `usage_score` on the row
dated D is their active minutes on the IST day **before** D (the last
complete day at the 00:15 IST run): the gap rule in users/active-time.ts
(`activeMs`) over the student's activity events — `media_metadata` whatsapp
voice notes AND comprehension flow taps (2026-09); a gap counts when shorter
than 120 s ending in a voice note or 298 s ending in a tap — 1 dp;
`usage_attempts` = events (notes + taps) that day; `usage_passed` =
minutes **strictly** > `USAGE_PASS_MINUTES` (5). A student with no note
that day gets NULL/NULL/0 — zero is never stored; every reader treats
absence as zero. Per area: `usage_n` counts EVERY student in the geo step
(no age band, unbanded included), absent students add 0 minutes to sum and
`hist[0]`; only a row dated D carries minutes (`latest-students` selects
`CASE WHEN t.computed_for = D THEN usage_score END`). These roll up
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
   `literacy_lesson_states` row or a whatsapp voice note newer than the
   student's latest `test_results_student.created_at` (or no row yet). NOT "activity since
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
   (age-bands.ts) contributes n=1, sum, sumsq, pass, hist[`histIndex`];
   usage contributes for every student (see above). nipun_g1/nipun_g2 are
   read through `impliedNipun`: a pass at a higher grade with the lower
   grade null or failed counts as 1.0 passed (see below).
7. Roll-up: for each school with ≥1 student, `GeoEntityService.ancestors`
   once (cached per school), and the student's vector is added to the school
   and every ancestor — so an ancestor's vector is exactly the sum of its
   descendant schools', without re-reading student rows above school level.
   Rows are written only for entities on an ancestor path of a school that
   has students. Upsert on `(geo_entity_id, computed_for)` in batches of
   `GEO_BATCH_SIZE`.
8. School verdict: cohort read, then per school leaf `schoolVerdict` on its
   finished vector, one-hot counts added to the school and its ancestors
   (section below).
9. Finish the `test_runs` row (`ok` + counts). Any exception → `failed`,
   `error` set, rethrown.

## NIPUN school verdict (migration 1792000000000-AddNipunSchoolVerdict)

A school-level pass/fail, distinct from the per-student `nipun_g*_pass`
counts. Computed in `aggregateGeo` after the student vectors, from each
school's own finished vector; nothing is backfilled — rows before the
deploy keep cohort 0, verdict NULL, counts 0.

- Cohort (`test-results:cohort` → `cohortVector`): EVERY non-deleted
  student with a birth year whose referrer has a geo entity — scored or
  not — adds 1 to `nipun_g2_cohort` / `nipun_g3_cohort` for each band whose
  age range (age-bands.ts, on computed_for; a missing birth month is
  estimated from `users.created_at`, which both reads select) holds them.
  Same membership join as latest-students minus the results row, so a
  school with twelve enrolled but three active children has a cohort of
  twelve. The bands are disjoint single years (g1 = 6, g2 = 7, g3 = 8),
  so a child is in at most one cohort. Additive up the tree like the
  metric vectors.
- `bandVerdict(cohort, pass)`: true when `pass ≥ NIPUN_SCHOOL_MIN_PASSERS`
  (9) AND `pass ≥ NIPUN_SCHOOL_PASS_SHARE` (0.75, inclusive) × cohort —
  no minimum cohort for a pass (9 of 9 passes); otherwise false from
  `NIPUN_SCHOOL_MIN_COHORT` (12) students, null below. `pass` is the
  band's `nipun_g*_pass` (scored, in-band, passed).
- `schoolVerdict(v)`: all three bands (g1, g2, g3 — g1 since migration
  1793000000000-AddNipunG1, 2026-10) true → true; any band null → null
  (g2 failing with g3 undecidable is still null); otherwise false.
- Only for leaves whose `geo_entity.type = 'school'`
  (`test-results:leaf-types`, one read per run over the referrers' geo
  ids): students referred straight onto a block count in its cohort and
  vectors, but a block gets no verdict and counts itself in nothing.
- Stored on the school row as `nipun_school_passed` (true/false/NULL; NULL
  on every non-school row) and one-hot in `nipun_schools_pass` / `_fail` /
  `_insufficient`, which `verdictVector` adds to the school AND every
  ancestor — so a district's three counts are how many of its schools
  pass / fail / can't be decided. `addVector` sums the cohorts and the three
  counts, never the boolean.
- Schools with no student at all (no results row, no cohort member) have no
  row and are counted nowhere — not even as insufficient.
- A higher grade implies the lower ones (`impliedNipun`, 2026-10): g3 ⇒
  g2 ⇒ g1. A child who passed g3 but has no g2 score (sped past the
  level-10 pool before four R1.x first attempts) or a failed g2 is taken
  as g2 = 1.0 / passed in `studentVector`; likewise a g2 pass (earned or
  implied) makes a null or failed g1 1.0 / passed. So a 7-year-old g3
  passer is a g2 passer, and a 6-year-old g2 passer a g1 passer, for
  their school's n/sum/pass/hist and verdict. An earned pass keeps its
  real score. A failed or missing higher grade implies nothing; mpl_b
  implies nothing. Roll-up only: `test_results_student`, the dashboard
  student lists and GET /users/:id/literacy-test-scores still show the
  raw lower grade (insufficient or failed) — a school's passers can
  exceed its listed passes.
- `upsertGeoRows` binds `VERDICT_COLUMNS` between the three student counts
  and the metric vectors; the nightly path updates them on conflict, the
  usage backfill path (`usageOnly`) leaves them alone.

## upsertStudentUsage / upsertGeoUsage — backfill writers

Used only by src/scripts/backfill-usage.ts (its prompt.md has the rules).
Both bind `created_at` to the historical nightly instant instead of now()
and, on conflict, update the usage columns only: student rows keep whatever
NIPUN/MPL-B the nightly wrote (NULL on rows created here); geo rows keep
students_active/scored/unbanded and the three test vectors. `upsertGeoRows`
takes an optional `{ usageOnly, createdAt }` for this; the nightly path is
unchanged.

## enqueue(full)

Mirrors MirrorService.enqueue: `already-running` while `isRunning()` or a
manual job (`jobId` `test-results-manual`) is waiting/active; otherwise adds
the job. `attempts: 1` in queues.ts — a failed night is never retried into
an overlapping run.
