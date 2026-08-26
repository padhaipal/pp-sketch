import {
  SOLVABILITY_MAX_CALLS,
  SOLVABILITY_REJECT_MIN_CORRECT,
  SOLVABILITY_REQUIRED_VALID,
  runZeroContextSolvability,
  SolvabilityBatchRunner,
  solvabilityGateApplies,
} from './zero-context-solvability';
import {
  GATE_BATCH_SIZE,
  GATE_JUDGE_MODEL,
  GATE_TEMPERATURE_RATIO,
} from './gate-shared';
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
  it('stops at exactly 24 issued calls (24 batches of 1) when every call is valid', async () => {
    const llm = runner((request) => letterOf(request, 'गलत-एक'));
    const verdict = await runZeroContextSolvability(llm, question);
    expect(SOLVABILITY_REQUIRED_VALID).toBe(24);
    expect(SOLVABILITY_MAX_CALLS).toBe(50);
    expect(llm.calls).toHaveLength(24);
    expect(llm.calls.every((batch) => batch.length === GATE_BATCH_SIZE)).toBe(
      true,
    );
    expect(verdict).toEqual({
      status: 'passed',
      correct: 0,
      valid_runs: 24,
      total_calls: 24,
      call_failures: 0,
      unparseable: 0,
    });
  });

  it('tops up invalid runs and scores exactly 24 valid runs', async () => {
    // 4 unparseable replies early → the sequential loop keeps issuing
    // single-call batches until 24 valid runs are collected, so exactly
    // 28 calls are issued and exactly 24 valid runs are scored.
    const llm = runner((request, i) =>
      i < 4 ? 'पता नहीं' : letterOf(request, 'गलत-एक'),
    );
    const verdict = await runZeroContextSolvability(llm, question);
    expect(llm.calls).toHaveLength(28);
    expect(llm.calls[27]).toHaveLength(1);
    expect(verdict).toEqual({
      status: 'passed',
      correct: 0,
      valid_runs: 24,
      total_calls: 28,
      call_failures: 0,
      unparseable: 4,
    });
  });

  it('returns unverified when 50 calls end short of 24 valid runs', async () => {
    // Only every 3rd call valid → 17 valid at budget exhaustion
    // (indices 0..49: 17 valid, 17 transport failures, 16 unparseable).
    const llm = runner((request, i) => {
      if (i % 3 === 1) return null; // transport failure
      if (i % 3 === 2) return 'पता नहीं'; // unparseable
      return letterOf(request, 'गलत-एक');
    });
    const verdict = await runZeroContextSolvability(llm, question);
    // 50 single-call batches clamped to the budget.
    expect(llm.calls).toHaveLength(50);
    expect(llm.calls[49]).toHaveLength(1);
    expect(verdict).toEqual({
      status: 'unverified',
      valid_runs: 17,
      total_calls: 50,
      call_failures: 17,
      unparseable: 16,
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
    expect(requests).toHaveLength(24);
    const firstLetters = new Set(requests.map((r) => letterOf(r, 'सही')));
    expect(firstLetters.size).toBeGreaterThan(1); // shuffled
    for (const r of requests) {
      expect(r.model).toBe(GATE_JUDGE_MODEL);
      expect(r.temperatureRatio).toBe(GATE_TEMPERATURE_RATIO); // cold
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
    expect(verdict.correct).toBe(24);
  });

  it('counts transport failures as call_failures and spends the whole budget', async () => {
    const llm = runner(() => null);
    const verdict = await runZeroContextSolvability(llm, question);
    expect(verdict).toEqual({
      status: 'unverified',
      valid_runs: 0,
      total_calls: 50,
      call_failures: 50,
      unparseable: 0,
    });
  });

  it('ignores letters beyond the option count (unparseable)', async () => {
    const llm = runner(() => 'D');
    const verdict = await runZeroContextSolvability(llm, questionWith(2));
    expect(verdict.status).toBe('unverified'); // no valid picks
    expect(verdict.unparseable).toBe(50);
    expect(verdict.call_failures).toBe(0);
  });
});

describe('solvabilityGateApplies', () => {
  it.each(['R1.2', 'R1.3'])(
    'applies to narrative %s questions',
    (questionType) => {
      expect(solvabilityGateApplies('narrative', questionType)).toBe(true);
    },
  );

  it.each([
    ['expository', 'R1.2'], // right question type, wrong passage type
    ['narrative', 'R1.1'], // word-meaning retrieve: out of scope since 2026-08-26
    ['narrative', 'R2.1'], // right passage type, non-retrieve question
    ['narrative', 'R3.1'],
    ['expository', 'R2.2'],
  ])('skips %s %s questions', (passageType, questionType) => {
    expect(solvabilityGateApplies(passageType, questionType)).toBe(false);
  });

  it('skips level-8 passages even for narrative R1.2 (question never shown)', () => {
    expect(solvabilityGateApplies('narrative', 'R1.2', 8)).toBe(false);
  });

  it.each([9, 12])('applies at level %i for narrative R1.2', (level) => {
    expect(solvabilityGateApplies('narrative', 'R1.2', level)).toBe(true);
  });
});
