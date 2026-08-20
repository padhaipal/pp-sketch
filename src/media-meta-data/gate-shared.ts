/**
 * Shared pieces of the two LLM generation gates (passage-judge and
 * zero-context solvability), including the sequential-batch run collector
 * both gates use to gather a fixed number of valid runs.
 */
import type { Span } from '@opentelemetry/api';
import type {
  LlmBatchItem,
  LlmBatchOptions,
  LlmRequest,
} from '../interfaces/llm/llm.dto';

/**
 * The single model behind both gates. Self-agreement caveat: one model both
 * confirming answerability-with-passage (judge gate) and measuring
 * guessability-without-passage (solvability gate) means its idiosyncrasies
 * cancel oddly — a bias that makes it "guess right" without the passage also
 * makes it "confirm" with the passage. Revisit if either gate's rejection
 * pattern looks model-shaped.
 */
export const GATE_JUDGE_MODEL = 'sarvam-105b';

export const OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const;

/** Calls per sequential gate batch (matches the batch runner's default concurrency). */
export const GATE_BATCH_SIZE = 8;

export interface GateBatchRunner {
  completeBatch(
    requests: LlmRequest[],
    options?: LlmBatchOptions,
  ): Promise<LlmBatchItem[]>;
}

/**
 * Observability counters carried by every gate verdict, whatever its status.
 * `call_failures` and `unparseable` partition the INVALID runs by cause, so
 * valid_runs + call_failures + unparseable = total_calls.
 */
export interface GateRunStats {
  /** Valid runs actually scored — never more than the gate's target. */
  valid_runs: number;
  /** Calls actually issued (every batch counted in full). */
  total_calls: number;
  /** Invalid runs: transport failure after the LLM client's own retries. */
  call_failures: number;
  /** Invalid runs: reply carried no parseable option letter. */
  unparseable: number;
}

/** The stats plus the correct-pick count (absent when a verdict is 'unverified'). */
export type GateObservability = GateRunStats & { correct?: number };

/** Copies exactly the observability fields out of a verdict (drops status etc.). */
export function pickGateObservability(v: GateObservability): GateObservability {
  return {
    valid_runs: v.valid_runs,
    ...(v.correct !== undefined && { correct: v.correct }),
    total_calls: v.total_calls,
    call_failures: v.call_failures,
    unparseable: v.unparseable,
  };
}

export function setGateSpanAttributes(span: Span, stats: GateRunStats): void {
  span.setAttribute('pp.gate.valid', stats.valid_runs);
  span.setAttribute('pp.gate.issued', stats.total_calls);
  span.setAttribute('pp.gate.call_failures', stats.call_failures);
  span.setAttribute('pp.gate.unparseable', stats.unparseable);
}

export interface GateRunCollection<R> {
  /**
   * Valid runs with their parsed pick, in issue order — exactly
   * `requiredValid` of them, or fewer only when the call budget ran out (the
   * gate must then return 'unverified').
   */
  scored: Array<{ run: R; picked: number }>;
  stats: GateRunStats;
}

/**
 * Collects `requiredValid` valid runs by issuing calls in sequential batches:
 * issue a batch, parse its results, update counters, and stop after the first
 * batch in which the target is reached or the `maxCalls` budget is spent —
 * never a batch beyond that. Each batch is sized
 * min(GATE_BATCH_SIZE, remaining valid deficit, remaining budget), so a batch
 * never over-delivers: on an all-valid run the gate issues exactly
 * `requiredValid` calls, and invalid runs trigger deficit-sized top-up
 * batches until the budget runs out. Every verdict is therefore computed over
 * exactly `requiredValid` valid runs (the final slice is defensive only —
 * deficit sizing means the loop cannot collect more).
 */
export async function collectValidRuns<
  R extends { request: LlmRequest },
>(opts: {
  llm: GateBatchRunner;
  buildRun: () => R;
  optionCount: number;
  requiredValid: number;
  maxCalls: number;
  batchOptions?: LlmBatchOptions;
}): Promise<GateRunCollection<R>> {
  const valid: Array<{ run: R; picked: number }> = [];
  let issued = 0;
  let callFailures = 0;
  let unparseable = 0;

  while (issued < opts.maxCalls && valid.length < opts.requiredValid) {
    const size = Math.min(
      GATE_BATCH_SIZE,
      opts.requiredValid - valid.length,
      opts.maxCalls - issued,
    );
    const runs = Array.from({ length: size }, () => opts.buildRun());
    const items = await opts.llm.completeBatch(
      runs.map((r) => r.request),
      opts.batchOptions,
    );
    issued += size;
    items.forEach((item, i) => {
      if (!item.result) {
        callFailures++;
        return;
      }
      const picked = parseAnswerLetter(item.result.text, opts.optionCount);
      if (picked === null) {
        unparseable++;
        return;
      }
      valid.push({ run: runs[i], picked });
    });
  }

  const scored = valid.slice(0, opts.requiredValid);
  return {
    scored,
    stats: {
      valid_runs: scored.length,
      total_calls: issued,
      call_failures: callFailures,
      unparseable,
    },
  };
}

export function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// The model must answer with a bare letter; we accept the first standalone
// A-D (case-insensitive) in the reply to survive mild chattiness.
export function parseAnswerLetter(
  text: string,
  optionCount: number,
): number | null {
  const match = /\b([A-Da-d])\b/.exec(text);
  if (!match) return null;
  const index = match[1].toUpperCase().charCodeAt(0) - 65;
  return index < optionCount ? index : null;
}
