/**
 * Zero-context solvability filter for LLM-generated comprehension questions.
 *
 * A well-designed passage question should NOT be answerable without the
 * passage. We send the question + options (no passage) to the shared gate
 * model, shuffling the option order every run, until exactly
 * SOLVABILITY_REQUIRED_VALID (144) valid runs are collected — issued in
 * sequential batches of GATE_BATCH_SIZE with a hard budget of
 * SOLVABILITY_MAX_CALLS (300) calls (see collectValidRuns in gate-shared.ts).
 * 144 = the 4! = 24 option orderings × 6, so every ordering of a 4-option
 * question is expected several times.
 *
 * The verdict is always computed over exactly 144 valid runs: the question is
 * rejected when the correct option was picked at least
 * SOLVABILITY_REJECT_MIN_CORRECT[optionCount] times (exact per-option-count
 * minima replacing the old 40%-of-valid threshold, 2026-08). If the call
 * budget is spent before 144 valid runs arrive the verdict is 'unverified' —
 * the question is rejected with a retriable reason rather than saved
 * unchecked (no DB row).
 *
 * Runs after the passage-judge gate and before any DB insert.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { tracer } from '../otel/otel';
import type { LlmBatchOptions, LlmRequest } from '../interfaces/llm/llm.dto';
import type { GeneratedQuestion } from './llm-generate.dto';
import {
  collectValidRuns,
  GATE_JUDGE_MODEL,
  GateBatchRunner,
  GateRunStats,
  OPTION_LETTERS,
  setGateSpanAttributes,
  shuffled,
} from './gate-shared';

/** The verdict is computed over exactly this many valid runs. */
export const SOLVABILITY_REQUIRED_VALID = 144;
/** Hard call budget; spent before 144 valid runs → 'unverified'. */
export const SOLVABILITY_MAX_CALLS = 300;
/**
 * Rejection minima over the fixed 144-valid denominator, per option count:
 * correct picks >= minimum → 'failed_solvable'.
 */
export const SOLVABILITY_REJECT_MIN_CORRECT: Record<2 | 3 | 4, number> = {
  2: 91,
  3: 67,
  4: 54,
};

export type SolvabilityBatchRunner = GateBatchRunner;

export interface SolvabilityVerdict extends GateRunStats {
  status: 'passed' | 'failed_solvable' | 'unverified';
  /** Correct picks over the 144 scored valid runs; absent when unverified. */
  correct?: number;
}

function buildRun(question: GeneratedQuestion): {
  request: LlmRequest;
  correctLetterIndex: number;
} {
  const order = shuffled(question.options);
  const correctLetterIndex = order.findIndex((o) => o.correct);
  const lines = order.map(
    (option, i) => `${OPTION_LETTERS[i]}. ${option.text}`,
  );
  return {
    correctLetterIndex,
    request: {
      model: GATE_JUDGE_MODEL,
      max_tokens: 10,
      messages: [
        {
          role: 'system',
          content:
            'You are answering a multiple choice question. Reply with only the letter of your chosen option and nothing else.',
        },
        {
          role: 'user',
          content: `${question.text}\n\n${lines.join('\n')}`,
        },
      ],
    },
  };
}

export async function runZeroContextSolvability(
  llm: SolvabilityBatchRunner,
  question: GeneratedQuestion,
  options?: LlmBatchOptions,
): Promise<SolvabilityVerdict> {
  return tracer.startActiveSpan('llm.solvability_filter', async (span) => {
    try {
      const { scored, stats } = await collectValidRuns({
        llm,
        buildRun: () => buildRun(question),
        optionCount: question.options.length,
        requiredValid: SOLVABILITY_REQUIRED_VALID,
        maxCalls: SOLVABILITY_MAX_CALLS,
        batchOptions: options,
      });

      let verdict: SolvabilityVerdict;
      if (stats.valid_runs < SOLVABILITY_REQUIRED_VALID) {
        verdict = { status: 'unverified', ...stats };
      } else {
        const correct = scored.filter(
          (s) => s.picked === s.run.correctLetterIndex,
        ).length;
        const minCorrect =
          SOLVABILITY_REJECT_MIN_CORRECT[question.options.length as 2 | 3 | 4];
        verdict = {
          status: correct >= minCorrect ? 'failed_solvable' : 'passed',
          correct,
          ...stats,
        };
      }

      span.setAttribute('pp.llm.solvability.status', verdict.status);
      setGateSpanAttributes(span, stats);
      return verdict;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
