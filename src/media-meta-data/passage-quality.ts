/**
 * Passage-quality gate for LLM-generated reading passages.
 *
 * Runs BEFORE the passage-judge gate (cheapest first: judges the passage
 * TEXT alone — no question, options, or explanations). The gate model reads
 * the passage above a fixed scoring rubric and must answer with the exact
 * word 'true' (score ≥ 4) or 'false'. A run is VALID only when the trimmed
 * response is exactly one of those two words — 'True', 'TRUE', '"true"',
 * '{true}' and every other variation count as unparseable, per the rubric's
 * own strictness clause.
 *
 * Collect QUALITY_REQUIRED_VALID (5) valid runs over at most
 * QUALITY_MAX_CALLS (8); PASS = ≥ QUALITY_PASS_MIN_TRUE (3) of the 5 are
 * true. Budget spent short of 5 valid → 'unverified' (rejected as
 * retriable, like the other gates; no DB row). Every call's raw response is
 * kept on the verdict — the dashboard shows them and the retro sweep
 * report archives them.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { tracer } from '../otel/otel';
import type { LlmBatchOptions, LlmRequest } from '../interfaces/llm/llm.dto';
import {
  GATE_JUDGE_MODEL,
  GateBatchRunner,
  GateRunStats,
  setGateSpanAttributes,
} from './gate-shared';

/** The verdict is computed over exactly this many valid runs. */
export const QUALITY_REQUIRED_VALID = 5;
/** Hard call budget; spent before 5 valid runs → 'unverified'. */
export const QUALITY_MAX_CALLS = 8;
/** PASS when at least this many of the 5 valid runs answered true. */
export const QUALITY_PASS_MIN_TRUE = 3;

// The exact rubric — the passage text is prepended above it, nothing else.
export const QUALITY_PROMPT = `Score the above passage based on the following criteria:
- spelling & grammatical correctness (-1 for each error)
- naturalness of language (0 = feels unnatural. 1 = medium. 2 = reads
  smoothly & naturally)
- readability (simple vocab, fairly short sentences). (0 = quite dense.
  1 = medium. 2 = appropriate for 8-10 year olds)
- (if its a narrative passage) literary quality. (0 = boring or confusing
  plot. 1 = moderately interesting. 2 = well-crafted plot)
- (if its an expository passage) interestingness. (0 = only obvious facts.
  1 = well structured. 2 = very interesting)
If the passage scores 4 or more, then return true. If it scores less than
4 return false. Only return the exact word true or the exact word false.
Do not return "true". Do not return {true}. Do not return True. Do not
return TRUE. Or any other variation. Failure to return exactly true or
false will result in a strictly failed response.`;

export type PassageQualityBatchRunner = GateBatchRunner;

export interface PassageQualityVerdict extends GateRunStats {
  status: 'passed' | 'failed_quality' | 'unverified';
  /** true-votes over the 5 scored valid runs; absent when unverified. */
  true_votes?: number;
  /**
   * Raw response of EVERY call in issue order — unparseable replies
   * verbatim; transport failures as a '[call failed: …]' marker so the
   * record stays index-aligned with total_calls.
   */
  runs: string[];
}

/** Exactly 'true' or 'false' after trim; anything else is unparseable. */
export function parseQualityAnswer(text: string): boolean | null {
  const trimmed = text.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return null;
}

function buildRequest(passageText: string): LlmRequest {
  return {
    model: GATE_JUDGE_MODEL,
    max_tokens: 10,
    messages: [
      { role: 'user', content: `${passageText}\n\n${QUALITY_PROMPT}` },
    ],
  };
}

export async function runPassageQuality(
  llm: PassageQualityBatchRunner,
  passageText: string,
  options?: LlmBatchOptions,
): Promise<PassageQualityVerdict> {
  return tracer.startActiveSpan('llm.passage_quality', async (span) => {
    try {
      // Same sequential deficit-sized collection as gate-shared's
      // collectValidRuns, but with the true/false parser (that helper is
      // hard-wired to option letters).
      const votes: boolean[] = [];
      const runs: string[] = [];
      let issued = 0;
      let callFailures = 0;
      let unparseable = 0;
      while (
        issued < QUALITY_MAX_CALLS &&
        votes.length < QUALITY_REQUIRED_VALID
      ) {
        const size = Math.min(
          1,
          QUALITY_REQUIRED_VALID - votes.length,
          QUALITY_MAX_CALLS - issued,
        );
        const items = await llm.completeBatch(
          Array.from({ length: size }, () => buildRequest(passageText)),
          options,
        );
        issued += size;
        for (const item of items) {
          if (!item.result) {
            callFailures++;
            runs.push(`[call failed: ${item.error?.message ?? 'unknown'}]`);
            continue;
          }
          runs.push(item.result.text);
          const vote = parseQualityAnswer(item.result.text);
          if (vote === null) {
            unparseable++;
            continue;
          }
          votes.push(vote);
        }
      }

      const stats: GateRunStats = {
        valid_runs: votes.length,
        total_calls: issued,
        call_failures: callFailures,
        unparseable,
      };
      let verdict: PassageQualityVerdict;
      if (votes.length < QUALITY_REQUIRED_VALID) {
        verdict = { status: 'unverified', runs, ...stats };
      } else {
        const trueVotes = votes.filter(Boolean).length;
        verdict = {
          status:
            trueVotes >= QUALITY_PASS_MIN_TRUE ? 'passed' : 'failed_quality',
          true_votes: trueVotes,
          runs,
          ...stats,
        };
      }

      span.setAttribute('pp.llm.quality.status', verdict.status);
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
