# dashboard-scores.dto.ts — public dashboard response shapes + arithmetic

Types for GET /geo-entities/:id/scores, /scores.csv and /spotlight
(dashboard-scores.controller.ts) and the pure arithmetic behind them
(dashboard-scores.spec.ts).

- `metric ∈ nipun_g2 | nipun_g3 | mpl_b`; `range ∈ 30 | 90` days, default 30
  (`DEFAULT_RANGE`, so spotlight tracks the page's toggle).
- `passRate(pass, n)` = pass/n × 100 to 1 dp, null at n = 0. `meanOf` =
  sum/n. `populationSd` = sqrt(sumsq/n − mean²) (clamped ≥ 0), 0 at n ≤ 1,
  null at n = 0. `delta(latest, prior)` to 1 dp, null when either is missing.
- `binOf(pass_rate, using)`: high ≥ 80, mid 50–79, low < 50, none when
  n = 0 or not using Lifteracy.
- `usingLifteracy(row)`: a row at as_of with `students_scored +
students_unbanded > 0` — NOT students_active: a school whose students went
  quiet keeps its last colour; activity is a separate number.
- `CHILD_TYPE_OF`: country → state → district → block → school → student.
- `studentLabel(name, ordinal)`: first name if set, else "Student N" —
  never anything derived from the phone number. `compareStudents`: scored
  desc, unscored by last_active_at desc, neither last (ties by label).
- `PUBLIC_CACHE_CONTROL = public, max-age=300`.
- `toCsv(rows)`: header from the first row's keys, RFC-4180 quoting.

Shapes: `ScoresResponse { as_of, metric, range, entity: GeoRef, root:
RootStats, series: SeriesPoint[], child_type, children: ChildRow[] |
StudentRow[], most_improved: ChildRow[] }`; `ChildRow = GeoRef +
{pass_rate, n, students_active, using_lifteracy, delta, bin, official}`;
`StudentRow {student_id, label, score, passed, attempts, in_band, active,
last_active_at}`; `SpotlightResponse {top, most_improved}` of `{child,
official}`; `Official {name, role_title, avatar_seed, spotlight_message}`.
