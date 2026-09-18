// The active-time rule, shared by UserActivityService (admin dashboard,
// report card) and the nightly usage metric (literacy/score/test-results):
// consecutive voice notes closer together than ACTIVE_GAP_THRESHOLD_MS count
// as time spent; a longer gap is a break. Pure.
export const ACTIVE_GAP_THRESHOLD_MS = 120_000;

export function activeMs(sortedTimesMs: readonly number[]): number {
  let active = 0;
  for (let i = 1; i < sortedTimesMs.length; i++) {
    const gap = sortedTimesMs[i] - sortedTimesMs[i - 1];
    if (gap > 0 && gap < ACTIVE_GAP_THRESHOLD_MS) active += gap;
  }
  return active;
}
