/**
 * Zero-context solvability filter for LLM-generated comprehension questions.
 *
 * A well-designed passage question should NOT be answerable without the
 * passage. We send the question + options (no passage) to sarvam-105b 100
 * times, shuffling the option order every run, and reject the question if the
 * correct option is picked in more than 40% of valid runs (thresholds set
 * 2026-07-27; applies to 2-, 3- and 4-option questions alike).
 *
 * Runs before any DB insert. If too few runs come back parseable/successful
 * the verdict is 'unverified' — the question is rejected with a retriable
 * reason rather than saved unchecked.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { tracer } from '../otel/otel';
import type {
  LlmBatchItem,
  LlmBatchOptions,
  LlmRequest,
} from '../interfaces/llm/llm.dto';
import type { GeneratedQuestion } from './llm-generate.dto';

export const SOLVABILITY_RUNS = 100;
export const SOLVABILITY_THRESHOLD = 0.4;
export const SOLVABILITY_MODEL = 'sarvam-105b';
/** Minimum parseable runs for a verdict; below this → 'unverified'. */
export const SOLVABILITY_MIN_VALID_RUNS = 80;

const OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const;

export interface SolvabilityBatchRunner {
  completeBatch(
    requests: LlmRequest[],
    options?: LlmBatchOptions,
  ): Promise<LlmBatchItem[]>;
}

export interface SolvabilityVerdict {
  status: 'passed' | 'failed_solvable' | 'unverified';
  /** correct picks / valid runs; absent when unverified. */
  rate?: number;
  valid_runs: number;
  total_runs: number;
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// The model must answer with a bare letter; we accept the first standalone
// A-D (case-insensitive) in the reply to survive mild chattiness.
function parseAnswerLetter(text: string, optionCount: number): number | null {
  const match = /\b([A-Da-d])\b/.exec(text);
  if (!match) return null;
  const index = match[1].toUpperCase().charCodeAt(0) - 65;
  return index < optionCount ? index : null;
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
      model: SOLVABILITY_MODEL,
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
  options?: LlmBatchOptions & { runs?: number },
): Promise<SolvabilityVerdict> {
  return tracer.startActiveSpan('llm.solvability_filter', async (span) => {
    try {
      const totalRuns = options?.runs ?? SOLVABILITY_RUNS;
      const runs = Array.from({ length: totalRuns }, () => buildRun(question));
      const items = await llm.completeBatch(
        runs.map((r) => r.request),
        options,
      );

      let valid = 0;
      let correct = 0;
      items.forEach((item, i) => {
        if (!item.result) return;
        const picked = parseAnswerLetter(
          item.result.text,
          question.options.length,
        );
        if (picked === null) return;
        valid++;
        if (picked === runs[i].correctLetterIndex) correct++;
      });

      let verdict: SolvabilityVerdict;
      if (valid < SOLVABILITY_MIN_VALID_RUNS * (totalRuns / SOLVABILITY_RUNS)) {
        verdict = {
          status: 'unverified',
          valid_runs: valid,
          total_runs: totalRuns,
        };
      } else {
        const rate = correct / valid;
        verdict = {
          status: rate > SOLVABILITY_THRESHOLD ? 'failed_solvable' : 'passed',
          rate,
          valid_runs: valid,
          total_runs: totalRuns,
        };
      }

      span.setAttribute('pp.llm.solvability.status', verdict.status);
      span.setAttribute('pp.llm.solvability.valid_runs', verdict.valid_runs);
      if (verdict.rate !== undefined) {
        span.setAttribute('pp.llm.solvability.rate', verdict.rate);
      }
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
