/**
 * Passage-judge gate for LLM-generated comprehension questions.
 *
 * The inverse check to zero-context solvability: WITH the passage, the
 * question must be reliably answerable. The gate model is shown the passage,
 * question and randomly ordered options 10 times; the question passes only if
 * every valid (parseable) response picks the correct option AND at least 8
 * runs were valid. Invalid/unparseable responses don't count as wrong — they
 * reduce the valid count, and below 8 valid the verdict is 'unverified'
 * (rejected as retriable, like solvability).
 *
 * On failure the verdict carries which option the gate model picked per miss
 * (original option-array indices). A judge consistently picking the same
 * wrong option means the answer key is wrong — the most valuable diagnostic
 * this gate produces; it is persisted in media_details.gate_failure.
 *
 * Runs cheap-first: DTO shape → this gate (10 calls) → solvability (144
 * calls) → TTS enqueue.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { tracer } from '../otel/otel';
import type { LlmBatchOptions, LlmRequest } from '../interfaces/llm/llm.dto';
import type { GeneratedQuestion } from './llm-generate.dto';
import {
  GATE_JUDGE_MODEL,
  GateBatchRunner,
  OPTION_LETTERS,
  parseAnswerLetter,
  shuffled,
} from './gate-shared';

export const JUDGE_RUNS = 10;
/** Minimum parseable runs for a verdict; below this → 'unverified'. */
export const JUDGE_MIN_VALID_RUNS = 8;

export interface PassageJudgeVerdict {
  status: 'passed' | 'failed_judge' | 'unverified';
  valid_runs: number;
  total_runs: number;
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
  options?: LlmBatchOptions & { runs?: number },
): Promise<PassageJudgeVerdict> {
  return tracer.startActiveSpan('llm.passage_judge', async (span) => {
    try {
      const totalRuns = options?.runs ?? JUDGE_RUNS;
      const correctIndex = question.options.findIndex((o) => o.correct);
      const runs = Array.from({ length: totalRuns }, () =>
        buildRun(passageText, question),
      );
      const items = await llm.completeBatch(
        runs.map((r) => r.request),
        options,
      );

      let valid = 0;
      const wrongPicks: number[] = [];
      items.forEach((item, i) => {
        if (!item.result) return;
        const picked = parseAnswerLetter(
          item.result.text,
          question.options.length,
        );
        if (picked === null) return;
        valid++;
        const original = runs[i].letterToOriginalIndex[picked];
        if (original !== correctIndex) wrongPicks.push(original);
      });

      let verdict: PassageJudgeVerdict;
      if (valid < JUDGE_MIN_VALID_RUNS * (totalRuns / JUDGE_RUNS)) {
        verdict = {
          status: 'unverified',
          valid_runs: valid,
          total_runs: totalRuns,
        };
      } else if (wrongPicks.length > 0) {
        verdict = {
          status: 'failed_judge',
          valid_runs: valid,
          total_runs: totalRuns,
          wrong_picks: wrongPicks,
        };
      } else {
        verdict = {
          status: 'passed',
          valid_runs: valid,
          total_runs: totalRuns,
        };
      }

      span.setAttribute('pp.llm.judge.status', verdict.status);
      span.setAttribute('pp.llm.judge.valid_runs', verdict.valid_runs);
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
