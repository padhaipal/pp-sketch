import {
  JUDGE_MIN_VALID_RUNS,
  JUDGE_RUNS,
  runPassageJudge,
} from './passage-judge';
import { GATE_JUDGE_MODEL, GateBatchRunner } from './gate-shared';
import type { LlmBatchItem, LlmRequest } from '../interfaces/llm/llm.dto';
import type { GeneratedQuestion } from './llm-generate.dto';

const passageText = 'एक दिन जंगल में एक शेर रहता था।';

const question: GeneratedQuestion = {
  text: 'जंगल में कौन रहता था?',
  question_type: 'R1.2',
  send_as_flow: true,
  options: [
    { text: 'शेर', correct: true, explanation: { text: 'e1' } },
    { text: 'हाथी', correct: false, explanation: { text: 'e2' } },
    { text: 'बंदर', correct: false, explanation: { text: 'e3' } },
    { text: 'मोर', correct: false, explanation: { text: 'e4' } },
  ],
};

// Finds the letter that a given option text was shuffled to in one run's
// user message ("A. शेर\nB. …").
function letterOf(request: LlmRequest, optionText: string): string {
  const lines = request.messages[1].content.split('\n');
  const line = lines.find((l) => l.endsWith(`. ${optionText}`));
  if (!line) throw new Error(`option ${optionText} not found in prompt`);
  return line[0];
}

function runner(
  answer: (request: LlmRequest, index: number) => string | null,
): GateBatchRunner & { calls: LlmRequest[][] } {
  const calls: LlmRequest[][] = [];
  return {
    calls,
    completeBatch: async (requests: LlmRequest[]): Promise<LlmBatchItem[]> => {
      calls.push(requests);
      return requests.map((request, i) => {
        const text = answer(request, i);
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

describe('runPassageJudge', () => {
  it('passes when every valid run picks the correct option', async () => {
    const llm = runner((request) => letterOf(request, 'शेर'));
    const verdict = await runPassageJudge(llm, passageText, question);
    expect(JUDGE_RUNS).toBe(10);
    expect(JUDGE_MIN_VALID_RUNS).toBe(8);
    expect(llm.calls[0]).toHaveLength(JUDGE_RUNS);
    expect(verdict.status).toBe('passed');
    expect(verdict.valid_runs).toBe(JUDGE_RUNS);
    expect(verdict.wrong_picks).toBeUndefined();
  });

  it('includes the passage, shuffles options, and uses the gate model', async () => {
    const llm = runner((request) => letterOf(request, 'शेर'));
    await runPassageJudge(llm, passageText, question, { runs: 50 });
    const requests = llm.calls[0];
    const correctLetters = new Set(requests.map((r) => letterOf(r, 'शेर')));
    expect(correctLetters.size).toBeGreaterThan(1); // shuffled per run
    for (const r of requests) {
      expect(r.model).toBe(GATE_JUDGE_MODEL);
      expect(r.messages[1].content).toContain(passageText);
      expect(r.messages[1].content).toContain(question.text);
    }
  });

  it('fails on a single wrong pick and records the picked option index', async () => {
    const llm = runner((request, i) =>
      i === 3 ? letterOf(request, 'बंदर') : letterOf(request, 'शेर'),
    );
    const verdict = await runPassageJudge(llm, passageText, question);
    expect(verdict.status).toBe('failed_judge');
    expect(verdict.valid_runs).toBe(10);
    // बंदर is options[2] in the ORIGINAL order regardless of shuffling.
    expect(verdict.wrong_picks).toEqual([2]);
  });

  it('a consistently repeated wrong pick shows up as a repeated index (bad answer key diagnostic)', async () => {
    const llm = runner((request) => letterOf(request, 'हाथी'));
    const verdict = await runPassageJudge(llm, passageText, question);
    expect(verdict.status).toBe('failed_judge');
    expect(verdict.wrong_picks).toEqual(Array(10).fill(1));
  });

  it('invalid responses reduce valid runs without counting as wrong', async () => {
    // 8 valid (all correct) + 2 unparseable → still a pass at exactly the floor.
    const llm = runner((request, i) =>
      i < 8 ? letterOf(request, 'शेर') : 'पता नहीं',
    );
    const verdict = await runPassageJudge(llm, passageText, question);
    expect(verdict.status).toBe('passed');
    expect(verdict.valid_runs).toBe(8);
  });

  it('returns unverified below 8 valid runs', async () => {
    const llm = runner((request, i) =>
      i < 7 ? letterOf(request, 'शेर') : null,
    );
    const verdict = await runPassageJudge(llm, passageText, question);
    expect(verdict.status).toBe('unverified');
    expect(verdict.valid_runs).toBe(7);
  });

  it('scales the min-valid floor when runs are overridden', async () => {
    // 20 runs → floor 16. 15 valid → unverified.
    const llm = runner((request, i) =>
      i < 15 ? letterOf(request, 'शेर') : null,
    );
    const verdict = await runPassageJudge(llm, passageText, question, {
      runs: 20,
    });
    expect(verdict.status).toBe('unverified');
    expect(verdict.valid_runs).toBe(15);
  });
});
