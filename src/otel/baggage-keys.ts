// W3C Baggage entries that pp-sketch propagates and surfaces on signals
// (spans, metrics, logs). Mirrors wabot-sketch/src/otel/baggage-keys.ts —
// both services must agree on the exact key strings for cross-service
// correlation. Producers (wabot's message.processor + accept.controller)
// set the entries; pp-sketch consumes them downstream.

export const BAGGAGE_LOAD_TEST = 'padhaipal.load_test';
export const BAGGAGE_TEST_PHASE = 'padhaipal.test_phase';

export const PROPAGATED_BAGGAGE_KEYS = [
  BAGGAGE_LOAD_TEST,
  BAGGAGE_TEST_PHASE,
] as const;
