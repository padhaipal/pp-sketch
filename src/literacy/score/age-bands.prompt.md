# age-bands.ts — metric age bands for geo aggregation

`METRIC_AGE_BANDS` — `[min, max)` whole years per metric, confirmed with
Tom 2026-10: nipun_g1 [6, 7), nipun_g2 [7, 8), nipun_g3 [8, 9), mpl_b
[10, 11). A test's
window runs from the child's min-th birthday to the day before their
max-th. The bands are disjoint — a child sits at most one test — and
nine-year-olds sit none (by decision).

`assumedBirth(birth_year, birth_month, createdAt?)` — the (year, month) the
age rule works from; the day is always the 1st.
- `birth_month` known (1–12): that month of `birth_year`.
- `birth_month` null, `createdAt` given: onboarding only recorded a stated
  age (`birth_year` = IST year of onboarding − age, onboarding.service.ts),
  so the child is taken to be that age **and a half** on the day they were
  onboarded: born `age × 12 + 6` months before the IST month of
  `createdAt`. Said "7" in March 2026 → born September 2018, turns 8 in
  September 2026; said "6" in January 2026 → born July 2019 and IS 6 that
  day (the old July-of-birth_year rule read them as 5 until July). Falls
  back to July when `birth_year` is after the onboarding year (edited
  later).
- Neither: July of `birth_year` (legacy callers without a `createdAt`).

`ageOn(date, birth_year, birth_month, createdAt?)` — whole years from the
assumed birth to `date` (a computed_for calendar date at midnight UTC);
null `birth_year` → null. Callers pass `users.created_at` as `createdAt`:
`studentVector` / `cohortVector` (test-results.service.ts, via
`LatestStudentRow.created_at` / `CohortRow.created_at`), the usage
backfill and the dashboard's per-student `in_band`.

`inBand(metric, age)` — always true for `usage` (no band; `LiteracyMetric`
= the four `TestMetric`s + `usage`). A student outside a metric's band is
excluded from that metric's `n` only; a null-`birth_year` student is
unbanded — excluded from every `n`, counted in `students_unbanded`.

The dashboard keeps a fallback copy of the bands
(pp-dashboard dashboard-types.ts `METRIC_AGE_BANDS`) for a pp-sketch that
predates `age_band` in the scores response — keep in sync.
