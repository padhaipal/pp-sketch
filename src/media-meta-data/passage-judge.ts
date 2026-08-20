/**
 * Passage-judge gate for LLM-generated comprehension questions.
 *
 * The inverse check to zero-context solvability: WITH the passage, the
 * question must be reliably answerable. The gate model is shown the passage,
 * question and randomly ordered options until exactly JUDGE_REQUIRED_VALID
 * (10) valid runs are collected — issued in sequential batches sized to the
 * remaining valid deficit (up to GATE_BATCH_SIZE) with a hard budget of
 * JUDGE_MAX_CALLS (14) calls, so an all-valid run issues exactly 10 calls in
 * batches of 8 + 2 (see collectValidRuns in gate-shared.ts). The question
 * passes only if all 10
 * valid runs pick the correct option. Invalid runs (transport failures,
 * unparseable replies) don't count as wrong — they just consume budget; if
 * the budget is spent before 10 valid runs arrive the verdict is
 * 'unverified' (rejected as retriable, like solvability; no DB row).
 *
 * On failure the verdict carries which option the gate model picked per miss
 * (original option-array indices). A judge consistently picking the same
 * wrong option means the answer key is wrong — the most valuable diagnostic
 * this gate produces; it is persisted in media_details.gate_failure.
 *
 * Runs cheap-first: DTO shape → this gate (≤14 calls) → solvability (≤300
 * calls) → TTS enqueue.
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
export const JUDGE_REQUIRED_VALID = 10;
/** Hard call budget; spent before 10 valid runs → 'unverified'. */
export const JUDGE_MAX_CALLS = 14;

export interface PassageJudgeVerdict extends GateRunStats {
  status: 'passed' | 'failed_judge' | 'unverified';
  /** Correct picks over the 10 scored valid runs; absent when unverified. */
  correct?: number;
  /**
   * Original option-array index the judge picked, one entry per valid run
   * that missed the correct option. Absent unless status is 'failed_judge'.
   */
  wrong_picks?: number[];
}

function buildRun(
  passageText: string,
  question: GeneratedQuestion,
): { request: LlmRequest; letterToOriginalIndex: number[] } {
  const indexed = question.options.map((option, originalIndex) => ({
    option,
    originalIndex,
  }));
  const order = shuffled(indexed);
  const lines = order.map(
    (entry, i) => `${OPTION_LETTERS[i]}. ${entry.option.text}`,
  );
  return {
    letterToOriginalIndex: order.map((entry) => entry.originalIndex),
    request: {
      model: GATE_JUDGE_MODEL,
      max_tokens: 10,
      messages: [
        {
          role: 'system',
          content:
            'You are answering a reading comprehension question about the given passage. Reply with only the letter of your chosen option and nothing else.',
        },
        {
          role: 'user',
          content: `${passageText}\n\n${question.text}\n\n${lines.join('\n')}`,
        },
      ],
    },
  };
}

export async function runPassageJudge(
  llm: GateBatchRunner,
  passageText: string,
  question: GeneratedQuestion,
  options?: LlmBatchOptions,
): Promise<PassageJudgeVerdict> {
  return tracer.startActiveSpan('llm.passage_judge', async (span) => {
    try {
      const correctIndex = question.options.findIndex((o) => o.correct);
      const { scored, stats } = await collectValidRuns({
        llm,
        buildRun: () => buildRun(passageText, question),
        optionCount: question.options.length,
        requiredValid: JUDGE_REQUIRED_VALID,
        maxCalls: JUDGE_MAX_CALLS,
        batchOptions: options,
      });

      let verdict: PassageJudgeVerdict;
      if (stats.valid_runs < JUDGE_REQUIRED_VALID) {
        verdict = { status: 'unverified', ...stats };
      } else {
        const wrongPicks = scored
          .map((s) => s.run.letterToOriginalIndex[s.picked])
          .filter((original) => original !== correctIndex);
        const correct = stats.valid_runs - wrongPicks.length;
        verdict =
          wrongPicks.length > 0
            ? {
                status: 'failed_judge',
                correct,
                wrong_picks: wrongPicks,
                ...stats,
              }
            : { status: 'passed', correct, ...stats };
      }

      span.setAttribute('pp.llm.judge.status', verdict.status);
      setGateSpanAttributes(span, stats);
      if (verdict.wrong_picks) {
        span.setAttribute(
          'pp.llm.judge.wrong_picks',
          verdict.wrong_picks.length,
        );
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
