// Geometric median of a point set (Weiszfeld's algorithm). Used for block
// coordinates (a block has no polygon and no point of its own) and by the
// dashboard's jitter path. The median, not the mean: a block with a dense
// cluster of schools plus three outliers 60 km away would otherwise put its
// label in empty countryside.

export interface Point {
  lat: number;
  lng: number;
}

export const WEISZFELD_ITERATIONS = 20;
// Stop early once a step moves the estimate less than this (degrees).
export const WEISZFELD_TOLERANCE = 1e-7;

export function arithmeticMean(points: readonly Point[]): Point | null {
  if (points.length === 0) return null;
  let lat = 0;
  let lng = 0;
  for (const p of points) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / points.length, lng: lng / points.length };
}

// Weiszfeld: seeded from the arithmetic mean, at most `iterations` steps,
// converging when the step falls below `tolerance`. Coordinates are treated
// as planar degrees — fine at block scale. A point coinciding with the
// current estimate would divide by zero; it is given a tiny distance instead,
// which is the standard guard and keeps the iteration well-defined.
export function geometricMedian(
  points: readonly Point[],
  iterations: number = WEISZFELD_ITERATIONS,
  tolerance: number = WEISZFELD_TOLERANCE,
): Point | null {
  const mean = arithmeticMean(points);
  if (!mean) return null;
  if (points.length <= 2) return mean;
  let current = mean;
  for (let i = 0; i < iterations; i++) {
    let wSum = 0;
    let lat = 0;
    let lng = 0;
    for (const p of points) {
      const d = Math.max(
        Math.hypot(p.lat - current.lat, p.lng - current.lng),
        1e-12,
      );
      const w = 1 / d;
      wSum += w;
      lat += p.lat * w;
      lng += p.lng * w;
    }
    const next = { lat: lat / wSum, lng: lng / wSum };
    const step = Math.hypot(next.lat - current.lat, next.lng - current.lng);
    current = next;
    if (step < tolerance) break;
  }
  return current;
}
