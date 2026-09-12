import {
  arithmeticMean,
  geometricMedian,
  WEISZFELD_ITERATIONS,
  WEISZFELD_TOLERANCE,
} from './geometric-median';

describe('geometricMedian', () => {
  it('is null for no points and the point itself / midpoint for one or two', () => {
    expect(geometricMedian([])).toBeNull();
    expect(geometricMedian([{ lat: 1, lng: 2 }])).toEqual({ lat: 1, lng: 2 });
    expect(
      geometricMedian([
        { lat: 0, lng: 0 },
        { lat: 2, lng: 2 },
      ]),
    ).toEqual({ lat: 1, lng: 1 });
  });

  it('a dense cluster plus far outliers: the median stays in the cluster, the mean drifts into empty countryside', () => {
    // 20 schools within ~1 km of (26.80, 80.90); three outliers ~60 km away.
    const cluster = Array.from({ length: 20 }, (_, i) => ({
      lat: 26.8 + (i % 5) * 0.002,
      lng: 80.9 + Math.floor(i / 5) * 0.002,
    }));
    // All three to the north-east so they don't cancel in the mean.
    const outliers = [
      { lat: 27.35, lng: 81.4 },
      { lat: 27.3, lng: 81.5 },
      { lat: 27.25, lng: 81.45 },
    ];
    const points = [...cluster, ...outliers];
    const median = geometricMedian(points)!;
    const mean = arithmeticMean(points)!;

    const clusterCentre = arithmeticMean(cluster)!;
    const dist = (
      a: { lat: number; lng: number },
      b: { lat: number; lng: number },
    ) => Math.hypot(a.lat - b.lat, a.lng - b.lng);
    // Median within ~0.5 km of the cluster; mean pulled > 5 km out.
    expect(dist(median, clusterCentre)).toBeLessThan(0.005);
    expect(dist(mean, clusterCentre)).toBeGreaterThan(0.05);
    expect(dist(mean, median)).toBeGreaterThan(0.04);
  });

  it('is symmetric for a square (median = centre) and tolerates a point at the seed', () => {
    const square = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 2, lng: 0 },
      { lat: 2, lng: 2 },
      { lat: 1, lng: 1 }, // coincides with the mean seed
    ];
    const m = geometricMedian(square)!;
    expect(m.lat).toBeCloseTo(1, 6);
    expect(m.lng).toBeCloseTo(1, 6);
  });

  it('stops early on convergence and caps at WEISZFELD_ITERATIONS', () => {
    expect(WEISZFELD_ITERATIONS).toBe(20);
    expect(WEISZFELD_TOLERANCE).toBe(1e-7);
    const points = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 1, lng: 0 },
      { lat: 5, lng: 5 },
    ];
    const capped = geometricMedian(points, 1)!;
    const converged = geometricMedian(points)!;
    // One iteration moves off the mean; full run moves further and settles.
    const mean = arithmeticMean(points)!;
    expect(
      Math.hypot(capped.lat - mean.lat, capped.lng - mean.lng),
    ).toBeGreaterThan(0);
    expect(
      Math.hypot(converged.lat - capped.lat, converged.lng - capped.lng),
    ).toBeGreaterThan(0);
    expect(geometricMedian(points, 20)).toEqual(geometricMedian(points, 200));
  });
});
