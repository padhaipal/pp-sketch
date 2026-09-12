# age-bands.ts — metric age bands for geo aggregation

`ageOn(date, birth_year, birth_month)` — whole years on `date` (a
computed_for calendar date at midnight UTC), birthday assumed the 1st of
the birth month; null `birth_month` assumes July; null `birth_year` → null.

`METRIC_AGE_BANDS` — `[min, max)` per metric: nipun_g2 [7, 9), nipun_g3
[8, 10), mpl_b [8, 10). **PLACEHOLDER VALUES — confirm with Tom before any
real decision reads them**; the source comment says the same.

`inBand(metric, age)`. Used by `studentVector` in test-results.service.ts: a
student outside a metric's band is excluded from that metric's `n` only; a
null-`birth_year` student is unbanded — excluded from every `n`, counted in
`students_unbanded`.
