# dashboard-scores.service.ts — reads for the public teacher dashboard

Reads only `test_results_geo_entity` / `test_results_student` (Prompt B's
nightly tables); never recomputes a score. Every statement carries a
`/* dashboard-scores:… */` tag (the spec's in-memory fake dispatches on it).

## scores(id, metric, range)

1. `GeoEntityService.getById`; when `:id` is not a geo entity it is treated
   as a TEACHER's user id (see "Class level" below); 404 only when it is
   neither. `child_type` from `CHILD_TYPE_OF` (school → `teacher`).
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
5. Teachers (school root): the school's student members (rule below)
   grouped by `users.referrer_user_id` — the referrer IS the teacher. One
   `ChildRow` per teacher: `id` = the teacher's user id, `type: 'teacher'`,
   `code ''`, no coordinates, `pass_rate` = passed / scored students, `n` =
   scored students, `students` = all members referred, `students_active`,
   `using_lifteracy: true`, `delta` against the students' prior rows,
   `official` = the teacher's own name / role_title (default "Teacher") /
   avatar_seed / spotlight_message (`dashboard-scores:teachers`, one query
   over the referrer ids; a deleted referrer keeps its row as "Teacher").
   Ordered pass_rate desc, then name. Students with no referrer are in the
   school's n but under no teacher. `most_improved` as for geo children.
6. Students (`students(scope)`, `MemberRow` — internal fields stripped by
   `toStudentRow`) — the deliberate exception to "results tables only",
   commented in the SQL and not to be optimised away:
   - School scope (`dashboard-scores:students`): membership = the
     student's LATEST `test_results_student` row's `geo_entity_id` (the
     compute-time school the geo vectors were built from), NOT
     `referrer.geo_entity_id`, which may have moved since the nightly run —
     a student must never be inside one school's n while listed under
     another. Candidates are students with any row for the school; members
     are those whose latest row is still there.
   - Class scope (`dashboard-scores:class`): membership =
     `users.referrer_user_id = teacher`, wherever the latest row sits.
   - `prior_score` / `prior_passed`: the student's newest row dated
     ≤ as_of − range (a `prior` CTE) → `delta` in points (score × 100) on
     every StudentRow; also feeds the teacher / class deltas.
   - `active` / `last_active_at`: one grouped `MAX(created_at)` over
     `literacy_lesson_states` per member (active = within 14 days of as_of).
   - `in_band`: `users.birth_year/birth_month` through age-bands.ts on as_of.
   - `label`: first name, else "Student N" with N a stable ordinal by
     `created_at` among current members (shifts if a student leaves or is
     re-referred — accepted for the pilot). Ordered scored desc → unscored
     by last_active_at → neither.

## Class level — `scores(<teacher user id>)`

`classScores`: `dashboard-scores:teacher` (users row, 404 if none) →
entity `{ id, type: 'teacher', code: '', name }`; `as_of` =
`MAX(computed_for)` over the referred students' rows
(`dashboard-scores:class-as-of`; none → the same 200-with-nulls shape,
`child_type: 'student'`). Root is aggregated from the class members
(pass_rate / mean / sd over scored students, students_active,
students_unbanded = members without a birth year, delta against their prior
rows); `series` = one `GROUP BY computed_for` over the referred students'
rows in (as_of − range, as_of] (`dashboard-scores:class-series`, also
`SUM(score)` → `mean`); `students_series` = the same rows per student
(`dashboard-scores:class-student-series`, minutes or score × 100) grouped
in member order;
`children` = StudentRow[] (with `delta`); `most_improved` is empty (the
client ranks students by delta itself).

## spotlight(id, metric, range)

Over `scores()`: `top` = highest pass_rate among children with n ≥ 5,
`most_improved` = `most_improved[0]`; each with its official. At school
level the children are teachers, so this spotlights teachers; both null at
class level (children are students).
