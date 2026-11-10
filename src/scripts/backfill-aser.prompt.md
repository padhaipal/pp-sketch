# backfill-aser — ASER proxy history (2026-11)

One-off (idempotent) fill of `aser_grade_*` for nights before the nightly
run knew the metric. `backfill-aser.ts` is pure over injected I/O;
`backfill-aser.main.ts` is the CLI.

```
node dist/scripts/backfill-aser.main.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]
```

- Default range: the night after the first finished ASER run … today (IST).
- Per night D, per tested student: level = the last `aserLevelHistory` point
  finished before D's 00:15 IST; age = `ageOn(D)`.
- Area rows (`test_results_geo_entity`): the student's `studentVector`
  `aser_grade` contribution (band 7 and under, age pass rule, no-age
  students out) summed through the referrer's CURRENT school and its
  ancestors; written with `TestResultsService.upsertGeoUsage(…,
  'aser_grade')` — on conflict only `aser_grade_*` changes; a missing row is
  inserted stamped 00:15 IST of D with every other figure zero.
- Student rows (`test_results_student`): `updateStudentAserGrade` — score
  (level ÷ 4), own verdict (`aserStudentPassed`), attempts — on rows that
  already exist for D only; never inserts.
- Nothing else is touched (no NIPUN / MPL-B / usage). `--dry-run` logs the
  per-night counts and writes nothing.
- After it: flush `dashboard:traction:*` (pp-redis-cache) or wait for the
  IST day to roll for the donor chart's "Passed ASER proxy" to pick it up.
