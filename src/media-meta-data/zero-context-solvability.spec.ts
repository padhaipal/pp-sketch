import {
  SOLVABILITY_MODEL,
  runZeroContextSolvability,
  SolvabilityBatchRunner,
} from './zero-context-solvability';
import type { LlmBatchItem, LlmRequest } from '../interfaces/llm/llm.dto';
import type { GeneratedQuestion } from './llm-generate.dto';

const question: GeneratedQuestion = {
  text: 'कहानी में कौन था?',
  question_type: 'retrieve',
  send_as_flow: true,
  options: [
    { text: 'सही', correct: true, explanation: { text: 'e1', tts: false } },
    { text: 'गलत-एक', correct: false, explanation: { text: 'e2', tts: false } },
    { text: 'गलत-दो', correct: false, explanation: { text: 'e3', tts: false } },
    {
      text: 'गलत-तीन',
      correct: false,
      explanation: { text: 'e4', tts: false },
    },
  ],
};

// Finds the letter that a given option text was shuffled to in one run's
// user message ("A. सही\nB. …").
function letterOf(request: LlmRequest, optionText: string): string {
  const lines = request.messages[1].content.split('\n');
  const line = lines.find((l) => l.endsWith(`. ${optionText}`));
  if (!line) throw new Error(`option ${optionText} not found in prompt`);
  return line[0];
}

function runner(
  answer: (request: LlmRequest) => string | null,
): SolvabilityBatchRunner & { calls: LlmRequest[][] } {
  const calls: LlmRequest[][] = [];
  return {
    calls,
    completeBatch: async (requests: LlmRequest[]): Promise<LlmBatchItem[]> => {
      calls.push(requests);
      return requests.map((request) => {
        const text = answer(request);
        return text === null
          ? { result: null, error: { message: 'boom', retriable: true } }
          : {
              result: {
                text,
                model: SOLVABILITY_MODEL,
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
  it('passes a question the model cannot solve blind', async () => {
    const llm = runner((request) => letterOf(request, 'गलत-एक'));
    const verdict = await runZeroContextSolvability(llm, question, {
      runs: 20,
    });
    expect(verdict.status).toBe('passed');
    expect(verdict.rate).toBe(0);
    expect(verdict.valid_runs).toBe(20);
  });

  it('shuffles options across runs and sends no passage', async () => {
    const llm = runner((request) => letterOf(request, 'गलत-एक'));
    await runZeroContextSolvability(llm, question, { runs: 50 });
    const requests = llm.calls[0];
    expect(requests).toHaveLength(50);
    const firstLetters = new Set(requests.map((r) => letterOf(r, 'सही')));
    expect(firstLetters.size).toBeGreaterThan(1); // shuffled
    for (const r of requests) {
      expect(r.model).toBe(SOLVABILITY_MODEL);
      expect(r.messages[1].content).toContain(question.text);
      expect(r.messages[1].content).not.toContain('कहानी है।'); // no passage
    }
  });

  it('fails a question the model answers correctly too often', async () => {
    const llm = runner((request) => letterOf(request, 'सही'));
    const verdict = await runZeroContextSolvability(llm, question, {
      runs: 20,
    });
    expect(verdict.status).toBe('failed_solvable');
    expect(verdict.rate).toBe(1);
  });

  it('accepts chatty answers and lowercase letters', async () => {
    const llm = runner(
      (request) =>
        `I think the answer is ${letterOf(request, 'सही').toLowerCase()}.`,
    );
    const verdict = await runZeroContextSolvability(llm, question, {
      runs: 10,
    });
    expect(verdict.status).toBe('failed_solvable');
  });

  it('returns unverified when too few runs are parseable', async () => {
    let i = 0;
    const llm = runner((request) =>
      i++ % 2 === 0 ? letterOf(request, 'गलत-एक') : 'मुझे नहीं पता',
    );
    const verdict = await runZeroContextSolvability(llm, question, {
      runs: 10,
    });
    expect(verdict.status).toBe('unverified');
    expect(verdict.valid_runs).toBe(5);
  });

  it('counts transport failures as invalid runs', async () => {
    const llm = runner(() => null);
    const verdict = await runZeroContextSolvability(llm, question, {
      runs: 10,
    });
    expect(verdict.status).toBe('unverified');
    expect(verdict.valid_runs).toBe(0);
  });

  it('ignores letters beyond the option count', async () => {
    const twoOption: GeneratedQuestion = {
      ...question,
      options: question.options.slice(0, 2).map((o, i) => ({
        ...o,
        correct: i === 0,
      })),
    };
    const llm = runner(() => 'D');
    const verdict = await runZeroContextSolvability(llm, twoOption, {
      runs: 10,
    });
    expect(verdict.status).toBe('unverified'); // no valid picks
  });
});
