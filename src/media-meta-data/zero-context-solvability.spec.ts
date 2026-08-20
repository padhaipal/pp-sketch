import {
  SOLVABILITY_MAX_CALLS,
  SOLVABILITY_REJECT_MIN_CORRECT,
  SOLVABILITY_REQUIRED_VALID,
  runZeroContextSolvability,
  SolvabilityBatchRunner,
} from './zero-context-solvability';
import { GATE_BATCH_SIZE, GATE_JUDGE_MODEL } from './gate-shared';
import type { LlmBatchItem, LlmRequest } from '../interfaces/llm/llm.dto';
import type { GeneratedQuestion } from './llm-generate.dto';

const question: GeneratedQuestion = {
  text: 'कहानी में कौन था?',
  question_type: 'R1.2',
  send_as_flow: true,
  options: [
    { text: 'सही', correct: true, explanation: { text: 'e1' } },
    { text: 'गलत-एक', correct: false, explanation: { text: 'e2' } },
    { text: 'गलत-दो', correct: false, explanation: { text: 'e3' } },
    { text: 'गलत-तीन', correct: false, explanation: { text: 'e4' } },
  ],
};

function questionWith(optionCount: 2 | 3 | 4): GeneratedQuestion {
  return {
    ...question,
    options: question.options
      .slice(0, optionCount)
      .map((o, i) => ({ ...o, correct: i === 0 })),
  };
}

// Finds the letter that a given option text was shuffled to in one run's
// user message ("A. सही\nB. …").
function letterOf(request: LlmRequest, optionText: string): string {
  const lines = request.messages[1].content.split('\n');
  const line = lines.find((l) => l.endsWith(`. ${optionText}`));
  if (!line) throw new Error(`option ${optionText} not found in prompt`);
  return line[0];
}

// `answer` gets the global 0-based call index across batches; null = the
// batch runner reporting a transport failure after its own retries.
function runner(
  answer: (request: LlmRequest, index: number) => string | null,
): SolvabilityBatchRunner & { calls: LlmRequest[][] } {
  const calls: LlmRequest[][] = [];
  let index = 0;
  return {
    calls,
    completeBatch: async (requests: LlmRequest[]): Promise<LlmBatchItem[]> => {
      calls.push(requests);
      return requests.map((request) => {
        const text = answer(request, index++);
        return text === null
          ? { result: null, error: { message: 'boom', retriable: true } }
          : {
              result: {
                text,
                model: GATE_JUDGE_MODEL,
                prompt_tokens: 1,
                completion_tokens: 1,
                duration_ms: 1,
              },
            };
      });
    },
  };
}

describe('runZeroContextSolvability', () => {
  it('stops at exactly 144 issued calls (18 batches of 8) when every call is valid', async () => {
    const llm = runner((request) => letterOf(request, 'गलत-एक'));
    const verdict = await runZeroContextSolvability(llm, question);
    expect(SOLVABILITY_REQUIRED_VALID).toBe(144);
    expect(SOLVABILITY_MAX_CALLS).toBe(300);
    expect(llm.calls).toHaveLength(18);
    expect(llm.calls.every((batch) => batch.length === GATE_BATCH_SIZE)).toBe(
      true,
    );
    expect(verdict).toEqual({
      status: 'passed',
      correct: 0,
      valid_runs: 144,
      total_calls: 144,
      call_failures: 0,
      unparseable: 0,
    });
  });

  it('counts the whole final batch but scores exactly 144 valid runs in issue order', async () => {
    // 4 unparseable replies early → the 144th valid run lands mid-batch 19.
    // The excess valid runs (global indices 148-151) answer CORRECT; if
    // issue-order truncation drops them, correct stays 0.
    const llm = runner((request, i) => {
      if (i < 4) return 'पता नहीं';
      return letterOf(request, i >= 148 ? 'सही' : 'गलत-एक');
    });
    const verdict = await runZeroContextSolvability(llm, question);
    expect(llm.calls).toHaveLength(19);
    expect(verdict).toEqual({
      status: 'passed',
      correct: 0, // the 4 excess correct runs were truncated, not scored
      valid_runs: 144,
      total_calls: 152, // the whole batch counts even once the target is hit
      call_failures: 0,
      unparseable: 4,
    });
  });

  it('returns unverified when 300 calls end short of 144 valid runs', async () => {
    // Only every 3rd call valid → 100 valid at budget exhaustion.
    const llm = runner((request, i) => {
      if (i % 3 === 1) return null; // transport failure
      if (i % 3 === 2) return 'पता नहीं'; // unparseable
      return letterOf(request, 'गलत-एक');
    });
    const verdict = await runZeroContextSolvability(llm, question);
    // 37 batches of 8 + a final batch of 4 clamped to the budget.
    expect(llm.calls).toHaveLength(38);
    expect(llm.calls[37]).toHaveLength(4);
    expect(verdict).toEqual({
      status: 'unverified',
      valid_runs: 100,
      total_calls: 300,
      call_failures: 100,
      unparseable: 100,
    });
  });

  it.each([
    [2, SOLVABILITY_REJECT_MIN_CORRECT[2]],
    [3, SOLVABILITY_REJECT_MIN_CORRECT[3]],
    [4, SOLVABILITY_REJECT_MIN_CORRECT[4]],
  ] as Array<[2 | 3 | 4, number]>)(
    '%d options: rejects at the %d-correct minimum, passes one below',
    async (optionCount, minCorrect) => {
      const q = questionWith(optionCount);
      const answerFirstNCorrect =
        (n: number) => (request: LlmRequest, i: number) =>
          letterOf(request, i < n ? 'सही' : 'गलत-एक');

      const atMinimum = await runZeroContextSolvability(
        runner(answerFirstNCorrect(minCorrect)),
        q,
      );
      expect(atMinimum.status).toBe('failed_solvable');
      expect(atMinimum.correct).toBe(minCorrect);

      const oneBelow = await runZeroContextSolvability(
        runner(answerFirstNCorrect(minCorrect - 1)),
        q,
      );
      expect(oneBelow.status).toBe('passed');
      expect(oneBelow.correct).toBe(minCorrect - 1);
    },
  );

  it('shuffles options across runs and sends no passage', async () => {
    const llm = runner((request) => letterOf(request, 'गलत-एक'));
    await runZeroContextSolvability(llm, question);
    const requests = llm.calls.flat();
    expect(requests).toHaveLength(144);
    const firstLetters = new Set(requests.map((r) => letterOf(r, 'सही')));
    expect(firstLetters.size).toBeGreaterThan(1); // shuffled
    for (const r of requests) {
      expect(r.model).toBe(GATE_JUDGE_MODEL);
      expect(r.messages[1].content).toContain(question.text);
      expect(r.messages[1].content).not.toContain('कहानी है।'); // no passage
    }
  });

  it('accepts chatty answers and lowercase letters', async () => {
    const llm = runner(
      (request) =>
        `I think the answer is ${letterOf(request, 'सही').toLowerCase()}.`,
    );
    const verdict = await runZeroContextSolvability(llm, question);
    expect(verdict.status).toBe('failed_solvable');
    expect(verdict.correct).toBe(144);
  });

  it('counts transport failures as call_failures and spends the whole budget', async () => {
    const llm = runner(() => null);
    const verdict = await runZeroContextSolvability(llm, question);
    expect(verdict).toEqual({
      status: 'unverified',
      valid_runs: 0,
      total_calls: 300,
      call_failures: 300,
      unparseable: 0,
    });
  });

  it('ignores letters beyond the option count (unparseable)', async () => {
    const llm = runner(() => 'D');
    const verdict = await runZeroContextSolvability(llm, questionWith(2));
    expect(verdict.status).toBe('unverified'); // no valid picks
    expect(verdict.unparseable).toBe(300);
    expect(verdict.call_failures).toBe(0);
  });
});
