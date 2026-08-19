/**
 * Shared pieces of the two LLM generation gates (passage-judge and
 * zero-context solvability).
 */
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

export interface GateBatchRunner {
  completeBatch(
    requests: LlmRequest[],
    options?: LlmBatchOptions,
  ): Promise<LlmBatchItem[]>;
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
