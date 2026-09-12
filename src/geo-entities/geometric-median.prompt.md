# geometric-median.ts — Weiszfeld geometric median

`geometricMedian(points, iterations = 20, tolerance = 1e-7)` — the point
minimising the sum of distances to `points` (planar degrees; fine at block
scale). Seeded from `arithmeticMean`, at most 20 Weiszfeld steps, stops early
when a step moves less than 1e-7°. One or two points return the mean. A point
coinciding with the current estimate gets a tiny distance (1e-12) instead of
dividing by zero. Null for an empty set.

Why not the mean: a block with a dense cluster of schools plus a few outliers
60 km away would put its label in empty countryside. The spec pins that with
a cluster-plus-outliers fixture where median and mean differ materially.

Used by backfill-block-coords.ts (block label points) and by the dashboard's
jitter path.
