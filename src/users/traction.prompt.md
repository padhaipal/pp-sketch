# traction — the donor page's public traction series

`GET users/dashboard/traction` (user.controller.ts, before `:id` routes) →
`TractionService.get()` → `TractionResponse { from, to, computed_at,
daily: TractionDay[], monthly: TractionMonth[], totals }`. Public through the pp-dashboard proxy allowlist.
Aggregates only — no ids, names or numbers leave.

- **Window**: `TRACTION_FROM` (2026-04-01, IST) through yesterday (IST);
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
  ≤ X + 1 (a row dated D covers through 00:15 IST on D);
  `aser_passed` (2026-11) = children aged 7 and under reading at grade
  level on the ASER proxy — the country rows' `aser_grade_pass` in
  `test_results_geo_entity` (so it matches the map's headline; students
  with no school or no age are not in it), latest row dated ≤ X + 1.
- **Totals** (headline, all time through `to`): `totals.hours` = active
  hours over every user, whole; `totals.students` = onboarded students.
- **Monthly** (per IST month of the window): onboarded students with ≥ 1
  IST day > 5 min active that month, split `joined_earlier` (onboarded in
  an earlier month) / `joined_this_month` (that month or later). The month
  in progress also gets `projected_*` = count × days in month ÷ complete
  days so far (simple linear); null for complete months.
- **DAU / MAU** (2026-11, on each `monthly` row; the donor chart's
  "DAU / MAU" toggle): over students onboarded by the end of that month,
  active on a day = sent at least one message that IST day (any
  `per_user_day` row — the 'u' rows of `traction:activity`). `mau` =
  students who wrote on any day of the month; `dau_avg` = the mean over
  every day of the month (zero days included; the month in progress: its
  complete days) of how many wrote that day, 1 dp; `dau_mau` = dau_avg ÷
  mau as a percentage, 1 dp, null at mau 0. The month in progress also gets
  `projected_dau_mau`, its month-end estimate: the ratio starts high and
  settles as the month's audience builds up, so the ratio so far is scaled
  by how the PREVIOUS month moved from the same number of days in to its
  end (previous final ratio ÷ previous ratio over its first N days); null
  when the previous month has nothing to compare with. (A linear scale-up
  of `mau`, as the counts above use, would read far too low early on.)
- **Cache**: pp-redis-cache key `dashboard:traction:v7:<IST date>`, TTL
  26 h; a concurrent miss shares one in-flight computation.
- **Warm**: queue `traction-warm`, cron `TRACTION_WARM_CRON` 20:00 UTC =
  01:30 IST (after the 00:15 IST test results), `refresh()` overwrites the
  day's key; registered in main.ts (pinned by traction.spec.ts).
- Pure assembly in traction.ts (`buildTraction`), unit-tested.

## 2026-11: counted students need 5 active minutes; new monthly projection

- `students_onboarded` and `totals.students`: onboarded students whose
  all-time active time (active-time.ts gap rule) has reached 5 minutes,
  counted from the later of the onboarding day and the day it was reached
  (`activeFrom`, the `'q'` rows of the activity query). Units, monthly active
  students and DAU / MAU still read every onboarded student.
- Monthly projection: `R × (30 ÷ d)^0.35 + N × 30 ÷ d`, R = joined earlier,
  N = joined this month, d = complete days so far capped at 30. Replaces the
  linear scale-up.
- Cache key bumped to v7.
