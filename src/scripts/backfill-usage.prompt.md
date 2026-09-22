# backfill-usage.ts / .main.ts — usage history for the teacher dashboard

The nightly test-results run (literacy/score/test-results.service.prompt.md)
started on 2026-09-16; WhatsApp voice notes go back to 2026-04-13. This
one-off fills `test_results_student.usage_*` and the `usage_*` columns of
`test_results_geo_entity` for every `computed_for` date in `[from, to]`
(default 2026-04-14 … today IST) so a teacher's class series shows minutes
from the start. NIPUN / MPL-B are never computed or touched.

Scope: `users.role = 'student'`, not deleted, **with a referrer** (the
teacher dashboard's class is the referrer's students). Unreferred students
and synthetic accounts are ignored.

`backfillUsage(deps, { from, to, dryRun })` (pure over injected I/O):
1. `backfill-usage:students` — id, birth_year/month, created_at, and the
   referrer's CURRENT `geo_entity_id` (run this after teachers have been
   promoted and given a school, or the geo phase writes nothing).
2. `backfill-usage:voice-notes` — one read for the whole range, from the
   nightly instant of `from − 1` to that of `to`, bucketed by (student, IST
   day). `backfill-usage:lessons` — one read for `students_active`.
3. Per day D (row dated D = IST day D−1, `nightlyInstant(D)` = 00:15 IST):
   - students with ≥1 note → `TestResultsService.upsertStudentUsage` in
     batches of STUDENT_BATCH_SIZE: `activeMs` minutes (1 dp), note count,
     pass strictly > USAGE_PASS_MINUTES; no row when no note (absence = 0).
   - every referred student that existed before that instant and whose
     referrer has a school → `studentVector` with NIPUN nulls and the day's
     minutes (absent = 0), summed into the school and each ancestor
     (`GeoEntityService.ancestors`, cached per school) →
     `TestResultsService.upsertGeoUsage`.
4. Summary `{students, days, studentRows, geoRows}`; one log line per day.

Both writers bind `created_at` to the nightly instant and, on conflict,
update ONLY the usage columns — `aggregateGeo` picks each student's latest
row by `created_at` and `candidates()` compares activity against it, so a
row stamped now() would shadow tonight's real scores. Idempotent.

Run (dry run first):
`railway ssh --service pp-sketch -- node dist/scripts/backfill-usage.main.js --dry-run`
then without the flag; `--from` / `--to` accept YYYY-MM-DD. Afterwards
`POST /admin/test-results/run?full=1` so today's rows include everyone.
