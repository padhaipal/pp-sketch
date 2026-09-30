// The active-time rule, shared by UserActivityService (admin dashboard,
// report card, usage milestones), the nightly usage metric
// (literacy/score/test-results) and the usage backfill. A student's activity
// events are their WhatsApp voice notes AND their comprehension flow taps;
// the gap between two consecutive events counts as time spent when it is
// shorter than the allowance of the event that ENDS it, otherwise it is a
// break. Pure — every reader (TS or SQL) must go through this file so the
// rule cannot drift between them.

// Gap ending in a voice note.
export const ACTIVE_GAP_THRESHOLD_MS = 120_000;

// Gap ending in a flow tap: the student was reading the passage and the
// question inside the flow, which takes as long as reading a passage aloud —
// the same 4 min 58 s the lesson allows a passage read before it goes stale
// (literacy-lesson.service.ts, awaitingPassageRead).
export const TAP_ACTIVE_GAP_THRESHOLD_MS = 298_000;

// An IST day counts towards a usage streak once it holds at least this much
// active time (the 5-minute daily milestone).
export const STREAK_DAY_MIN_ACTIVE_MS = 5 * 60_000;

export interface ActivityEvent {
  at: number; // epoch ms
  tap: boolean; // a comprehension flow tap (else a voice note)
}

export function activeMs(sortedEvents: readonly ActivityEvent[]): number {
  let active = 0;
  for (let i = 1; i < sortedEvents.length; i++) {
    const gap = sortedEvents[i].at - sortedEvents[i - 1].at;
    const allowance = sortedEvents[i].tap
      ? TAP_ACTIVE_GAP_THRESHOLD_MS
      : ACTIVE_GAP_THRESHOLD_MS;
    if (gap > 0 && gap < allowance) active += gap;
  }
  return active;
}

// ─── SQL fragments (media_metadata) ──────────────────────────────────────────

const col = (alias: string, name: string) =>
  alias ? `${alias}.${name}` : name;

// The rows that are a student's interactions: WhatsApp voice notes and
// comprehension flow taps (the text row the inbound processor anchors an
// nfm_reply to). No rolled_back filter — activity readers add it, history
// views deliberately do not.
export const INTERACTION_MEDIA_SQL = (alias = '') =>
  `${col(alias, 'source')} = 'whatsapp' AND (${col(alias, 'media_type')} = 'audio' OR (${col(alias, 'media_type')} = 'text' AND ${col(alias, 'media_details')}->>'nfm_reply' = 'true'))`;

// Activity events = live interactions.
export const ACTIVITY_EVENT_SQL = (alias = '') =>
  `${INTERACTION_MEDIA_SQL(alias)} AND ${col(alias, 'rolled_back')} = false`;

// Among interaction rows only: is this one a tap?
export const IS_TAP_SQL = (alias = '') =>
  `(${col(alias, 'media_type')} = 'text')`;

// SQL twin of activeMs' per-gap test.
export const COUNTED_GAP_SQL = (gapMs: string, isTap: string) =>
  `${gapMs} > 0 AND ${gapMs} < CASE WHEN ${isTap} THEN ${TAP_ACTIVE_GAP_THRESHOLD_MS} ELSE ${ACTIVE_GAP_THRESHOLD_MS} END`;
