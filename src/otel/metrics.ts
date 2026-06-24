import { context, metrics, propagation } from '@opentelemetry/api';
import { BAGGAGE_LOAD_TEST, BAGGAGE_TEST_PHASE } from './baggage-keys';

const meter = metrics.getMeter('pp');

/**
 * Milliseconds spent inside pp-sketch handling a single wabot-inbound BullMQ job,
 * measured from dequeue to job-completion (success or terminal failure).
 *
 * Attributes:
 *   outcome: one of "success" | "skipped" | "error"
 *     - "success"  — the job ran through a terminal branch that delivered a reply to the user
 *                    (includes the audio-reply path, new-user onboarding, non-audio redirect,
 *                    and the system-message phone-update branch).
 *     - "skipped"  — the job short-circuited before doing meaningful work
 *                    (consecutive message, or the incoming WhatsApp timestamp was >20s stale).
 *     - "error"    — the job threw and will be retried / dead-lettered by BullMQ.
 *
 * Note: this is pp-internal stage latency. End-to-end user-perceived delivery latency
 * is already captured by `wabot.message.e2e_duration_ms` on the wabot side via W3C
 * Baggage propagation, so do NOT re-record that here.
 */
export const wabotInboundJobDuration = meter.createHistogram(
  'pp.wabot_inbound.job_duration_ms',
  {
    description:
      'Milliseconds pp-sketch spent handling a wabot-inbound BullMQ job, from dequeue to completion.',
    unit: 'ms',
    advice: {
      explicitBucketBoundaries: [
        5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
        15000, 20000, 25000, 30000, 60000,
      ],
    },
  },
);

export type WabotInboundJobOutcome = 'success' | 'skipped' | 'error';

// Builds the attribute set for wabotInboundJobDuration. Reads
// padhaipal.load_test + padhaipal.test_phase from the active context's
// W3C Baggage (set upstream in wabot's message.processor + accept
// controller; flows in via the OtelCarrier on the BullMQ job). load_test
// defaults to 'false' so the label is always present and Prometheus
// queries can use exact-match filters. test_phase is only attached when
// the upstream accept controller saw the x-test-phase header.
export function buildJobAttributes(
  outcome: WabotInboundJobOutcome,
): Record<string, string> {
  const baggage = propagation.getBaggage(context.active());
  const loadTest = baggage?.getEntry(BAGGAGE_LOAD_TEST)?.value ?? 'false';
  const testPhase = baggage?.getEntry(BAGGAGE_TEST_PHASE)?.value;

  const attrs: Record<string, string> = { outcome, load_test: loadTest };
  if (typeof testPhase === 'string' && testPhase.length > 0) {
    attrs.test_phase = testPhase;
  }
  return attrs;
}
