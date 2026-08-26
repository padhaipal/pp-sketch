import {
  JUDGE_MAX_CALLS,
  JUDGE_REQUIRED_VALID,
  runPassageJudge,
  judgeGateApplies,
  JUDGE_SKIPPED_PASSAGE_LEVEL,
} from './passage-judge';
import {
  GATE_BATCH_SIZE,
  GATE_JUDGE_MODEL,
  GATE_TEMPERATURE_RATIO,
  GateBatchRunner,
} from './gate-shared';
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

// `answer` gets the global 0-based call index across batches; null = the
// batch runner reporting a transport failure after its own retries.
function runner(
  answer: (request: LlmRequest, index: number) => string | null,
): GateBatchRunner & { calls: LlmRequest[][] } {
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

describe('runPassageJudge', () => {
  it('all calls valid: issues exactly 10 single-call batches and scores them all', async () => {
    const llm = runner((request) => letterOf(request, 'शेर'));
    const verdict = await runPassageJudge(llm, passageText, question);
    expect(JUDGE_REQUIRED_VALID).toBe(10);
    expect(JUDGE_MAX_CALLS).toBe(14);
    // GATE_BATCH_SIZE = 1: calls issue one at a time and stop exactly at
    // the target — nothing is issued beyond it.
    expect(llm.calls.map((batch) => batch.length)).toEqual(
      Array(JUDGE_REQUIRED_VALID).fill(GATE_BATCH_SIZE),
    );
    expect(verdict).toEqual({
      status: 'passed',
      correct: 10,
      valid_runs: 10,
      total_calls: 10,
      call_failures: 0,
      unparseable: 0,
    });
  });

  it('includes the passage, shuffles options, and uses the gate model', async () => {
    const llm = runner((request) => letterOf(request, 'शेर'));
    await runPassageJudge(llm, passageText, question);
    const requests = llm.calls.flat();
    expect(requests).toHaveLength(10);
    const correctLetters = new Set(requests.map((r) => letterOf(r, 'शेर')));
    expect(correctLetters.size).toBeGreaterThan(1); // shuffled per run
    for (const r of requests) {
      expect(r.model).toBe(GATE_JUDGE_MODEL);
      expect(r.temperatureRatio).toBe(GATE_TEMPERATURE_RATIO); // cold
      expect(r.messages[1].content).toContain(passageText);
      expect(r.messages[1].content).toContain(question.text);
    }
  });

  it('fails on a single wrong pick among the 10 scored runs and records the picked option index', async () => {
    const llm = runner((request, i) =>
      i === 3 ? letterOf(request, 'बंदर') : letterOf(request, 'शेर'),
    );
    const verdict = await runPassageJudge(llm, passageText, question);
    expect(verdict.status).toBe('failed_judge');
    expect(verdict.valid_runs).toBe(10);
    expect(verdict.correct).toBe(9);
    // बंदर is options[2] in the ORIGINAL order regardless of shuffling.
    expect(verdict.wrong_picks).toEqual([2]);
  });

  it('a consistently repeated wrong pick shows up as a repeated index (bad answer key diagnostic)', async () => {
    const llm = runner((request) => letterOf(request, 'हाथी'));
    const verdict = await runPassageJudge(llm, passageText, question);
    expect(verdict.status).toBe('failed_judge');
    expect(verdict.wrong_picks).toEqual(Array(10).fill(1));
    expect(verdict.correct).toBe(0);
  });

  it('invalid responses trigger top-up calls without counting as wrong', async () => {
    // 2 unparseable early → the sequential loop keeps issuing single calls
    // until 10 valid runs are scored: 12 calls total, all correct.
    const llm = runner((request, i) =>
      i < 2 ? 'पता नहीं' : letterOf(request, 'शेर'),
    );
    const verdict = await runPassageJudge(llm, passageText, question);
    expect(llm.calls.map((batch) => batch.length)).toEqual(Array(12).fill(1));
    expect(verdict).toEqual({
      status: 'passed',
      correct: 10,
      valid_runs: 10,
      total_calls: 12,
      call_failures: 0,
      unparseable: 2,
    });
  });

  it('returns unverified when the 14-call budget ends short of 10 valid runs', async () => {
    // 3 transport failures + 2 unparseable → only 9 valid in 14 calls.
    const llm = runner((request, i) => {
      if (i < 3) return null;
      if (i < 5) return 'पता नहीं';
      return letterOf(request, 'शेर');
    });
    const verdict = await runPassageJudge(llm, passageText, question);
    expect(verdict).toEqual({
      status: 'unverified',
      valid_runs: 9,
      total_calls: 14,
      call_failures: 3,
      unparseable: 2,
    });
  });
});

describe('judgeGateApplies', () => {
  it('skips level 8 (question never shown — lesson ends on the read)', () => {
    expect(JUDGE_SKIPPED_PASSAGE_LEVEL).toBe(8);
    expect(judgeGateApplies(8)).toBe(false);
  });
  it.each([9, 10, 11, 12])('applies at level %i', (level) => {
    expect(judgeGateApplies(level)).toBe(true);
  });
});
