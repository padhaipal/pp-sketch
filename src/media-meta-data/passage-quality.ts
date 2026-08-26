/**
 * Passage-quality gate for LLM-generated reading passages.
 *
 * Runs BEFORE the passage-judge gate (cheapest first: judges the passage
 * TEXT alone — no question, options, or explanations). The gate model reads
 * the passage above a fixed scoring rubric and must answer with the exact
 * word 'true' (per the rubric's pass rule) or 'false'. A run is VALID only when the trimmed
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
export const QUALITY_PROMPT = `You are evaluating a short passage intended for children aged 8–10.

FIRST STEP: Count the total number of words in the passage.

IF THE PASSAGE IS 50 WORDS OR LESS:
• Do not evaluate literary quality, educational value, questions, or distractors.
• Check only language accuracy.
• If there are any clear spelling or grammar errors, return false.
• If there are no spelling or grammar errors, return true.

IF THE PASSAGE IS MORE THAN 50 WORDS:
Evaluate the passage using the criteria below.

1. Language accuracy
• Count clear spelling and grammar errors.
• Deduct 1 point for each clear error.

2. Naturalness of language
Score:
0 = unnatural, translated-sounding, or awkward
1 = understandable but some sentences feel forced
2 = smooth, child-friendly, and natural

3. Readability
Consider vocabulary, sentence length, sentence structure, and cognitive load.

Score:
0 = too difficult or dense for 8–10 year olds
1 = acceptable but occasionally difficult
2 = appropriate for independent reading by 8–10 year olds

4. Narrative quality (only if the passage is a story/narrative)

Score:
0 = boring, confusing, unrealistic, has no clear problem or resolution
1 = has a basic story but limited interest, weak conflict, or predictable ending
2 = engaging plot with clear characters, meaningful conflict, curiosity/suspense, and satisfying resolution

A narrative MUST FAIL if:
• the sequence of events is confusing
• the problem/conflict feels artificial or unnecessary
• the ending does not resolve the problem
• characters behave in ways children would find unrealistic
• the reader has no reason to care about what happens

5. Educational/value quality (only if the passage is expository/informational)

Score:
0 = only obvious facts, no meaningful idea or connection
1 = useful information or relatable idea
2 = highly engaging, meaningful, or thought-provoking

Decide whether the passage is narrative or expository.
Only score criterion 4 OR criterion 5, never both.

6. Question quality (only if questions are provided)

Score:
0 = irrelevant, confusing, or only tests copying
1 = relevant and checks understanding
2 = encourages thinking or application

7. Distractor quality (only if multiple-choice questions are provided)

Score:
0 = obviously wrong options
1 = some plausible options
2 = all options are plausible and require thinking

PASS RULE FOR PASSAGES OVER 50 WORDS:

Return true only if ALL conditions are met:
• Total score is at least 9 points
• Language accuracy has no serious errors
• Narrative quality is at least 1 for narratives
• Educational/value quality is at least 1 for expository passages
• No fatal narrative flaws are present

Otherwise return false.

Return ONLY:
true
or
false`;

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
