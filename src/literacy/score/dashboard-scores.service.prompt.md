# dashboard-scores.service.ts — reads for the public teacher dashboard

Reads only `test_results_geo_entity` / `test_results_student` (Prompt B's
nightly tables); never recomputes a score. Every statement carries a
`/* dashboard-scores:… */` tag (the spec's in-memory fake dispatches on it).

## scores(id, metric, range)

1. `GeoEntityService.getById` → 404 when unknown. `child_type` from
   `CHILD_TYPE_OF`.
2. Latest `test_results_geo_entity` row for the root → `as_of`. **No row →
   200 with root fields null, series/children/most_improved empty, as_of
   null** (a new school, or any entity before its first nightly run — a new
   teacher's first visit is exactly when the share link matters).
3. Root: pass_rate/mean/sd from n/pass/sum/sumsq; delta against the newest
   row dated ≤ as_of − range days (null if none); series = rows in
   (as_of − range, as_of].
4. Children (non-school roots): `descendants(id, child_type)` — one hop,
   paged at 500 — then three queries over the child ids: the rows at
   `as_of`, the prior rows for delta, and the officials. Each child carries
   the GeoRef (blocks' lat/lng are the backfilled label points), pass_rate,
   n, students_active, using_lifteracy, delta, bin and `official` — the
   NEWEST non-deleted education_official with `geo_entity_id = child.id`,
   on EVERY child because the teacher modal opens from any row.
   `most_improved` = children with n ≥ 5 by delta desc, top 5.
5. Students (school root) — the deliberate exception to "results tables
   only", commented in the SQL and not to be optimised away:
   - Membership = the student's LATEST `test_results_student` row's
     `geo_entity_id` (the compute-time school the geo vectors were built
     from), NOT `referrer.geo_entity_id`, which may have moved since the
     nightly run — a student must never be inside one school's n while
     listed under another. Candidates are students with any row for the
     school; members are those whose latest row is still there.
   - `active` / `last_active_at`: one grouped `MAX(created_at)` over
     `literacy_lesson_states` per member (active = within 14 days of as_of).
   - `in_band`: `users.birth_year/birth_month` through age-bands.ts on as_of.
   - `label`: first name, else "Student N" with N a stable ordinal by
     `created_at` among current members (shifts if a student leaves or is
     re-referred — accepted for the pilot). Ordered scored desc → unscored
     by last_active_at → neither.

## spotlight(id, metric, range)

Over `scores()`: `top` = highest pass_rate among children with n ≥ 5,
`most_improved` = `most_improved[0]`; each with its official. Both null at
school level.
