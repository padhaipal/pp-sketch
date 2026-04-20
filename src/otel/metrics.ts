import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('pp');

/**
 * Milliseconds spent inside pp-sketch handling a single wabot-inbound BullMQ job,
 * measured from dequeue to job-completion (success or terminal failure).
 *
 * Attributes:
 *   outcome: one of "success" | "dedupe" | "error"
 *     - "success"  — the job ran end-to-end and pp-sketch handed a reply back to wabot
 *     - "dedupe"   — short-circuited because the message was already being / had been processed
 *     - "error"    — the job threw and will be retried / dead-lettered by BullMQ
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
  },
);
