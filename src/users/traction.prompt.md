# traction — the donor page's public traction series

`GET users/dashboard/traction` (user.controller.ts, before `:id` routes) →
`TractionService.get()` → `TractionResponse { from, to, computed_at,
daily: TractionDay[] }`. Public through the pp-dashboard proxy allowlist.
Aggregates only — no ids, names or numbers leave.

- **Window**: `TRACTION_FROM` (2026-08-01, IST) through yesterday (IST);
  today is never included (partial).
- **Flows** (per IST day): `users_over_5min`, `minutes` (1 dp) — the
  active-time.ts gap rule via `PER_USER_DAY_ACTIVE_CTES`
  (daily-activity.sql.ts, shared with the staff summary).
- **Stocks** (end of day, history before the window included):
  `students_onboarded` (UserService.isOnboarded: created before
  ONBOARDING_CUTOFF → created_at, else recording_permissions_obtained_at
  with birth_year set; role student or null; not deleted);
  `teachers_onboarded` (education_official on a school, by created_at);
  `schools` / `blocks` / `districts` / `states` = units with ≥ 1 onboarded
  student through the referrer's geo entity and its ancestors, from the
  first; `mpl_b_passed` = students whose latest nightly
  `test_results_student.mpl_b_passed` is true, day X reading rows dated
  ≤ X + 1 (a row dated D covers through 00:15 IST on D).
- **Cohort**: `cohort_avg_lifetime_hours` = mean lifetime active hours (to
  now) of the students onboarded that day, 2 dp; null without a cohort.
  Nothing hidden — young cohorts are low by construction.
- **Cache**: pp-redis-cache key `dashboard:traction:v2:<IST date>`, TTL
  26 h; a concurrent miss shares one in-flight computation.
- **Warm**: queue `traction-warm`, cron `TRACTION_WARM_CRON` 20:00 UTC =
  01:30 IST (after the 00:15 IST test results), `refresh()` overwrites the
  day's key; registered in main.ts (pinned by traction.spec.ts).
- Pure assembly in traction.ts (`buildTraction`), unit-tested.
