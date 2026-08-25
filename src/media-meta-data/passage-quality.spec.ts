import {
  QUALITY_MAX_CALLS,
  QUALITY_PROMPT,
  QUALITY_REQUIRED_VALID,
  parseQualityAnswer,
  runPassageQuality,
  PassageQualityBatchRunner,
} from './passage-quality';
import { GATE_JUDGE_MODEL } from './gate-shared';
import type { LlmBatchItem, LlmRequest } from '../interfaces/llm/llm.dto';

const PASSAGE = 'नीली पहाड़ी गाँव में अमन नाम का लड़का रहता था।';

// `answer` gets the global 0-based call index; null = transport failure.
function runner(
  answer: (index: number) => string | null,
): PassageQualityBatchRunner & { calls: LlmRequest[][] } {
  const calls: LlmRequest[][] = [];
  let index = 0;
  return {
    calls,
    completeBatch: async (requests: LlmRequest[]): Promise<LlmBatchItem[]> => {
      calls.push(requests);
      return requests.map(() => {
        const text = answer(index++);
        return text === null
          ? { result: null, error: { message: 'down', retriable: true } }
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

describe('parseQualityAnswer', () => {
  it.each(['true', 'false', '  true  ', '\nfalse\n'])(
    'accepts %j (exact after trim)',
    (raw) => {
      expect(parseQualityAnswer(raw)).toBe(raw.trim() === 'true');
    },
  );

  it.each([
    'True',
    'TRUE',
    'FALSE',
    'False',
    '"true"',
    '{true}',
    '(true)',
    'true.',
    'the answer is true',
    'truefalse',
    '',
    '   ',
  ])('rejects %j as unparseable', (raw) => {
    expect(parseQualityAnswer(raw)).toBeNull();
  });
});

describe('runPassageQuality', () => {
  it('prepends the passage above the exact rubric and uses the gate model', async () => {
    const llm = runner(() => 'true');
    await runPassageQuality(llm, PASSAGE);
    const requests = llm.calls.flat();
    expect(requests).toHaveLength(QUALITY_REQUIRED_VALID);
    for (const request of requests) {
      expect(request.model).toBe(GATE_JUDGE_MODEL);
      expect(request.messages).toHaveLength(1);
      expect(request.messages[0].content).toBe(
        `${PASSAGE}\n\n${QUALITY_PROMPT}`,
      );
    }
  });

  it('3 of 5 true → passed', async () => {
    const llm = runner((i) => (i < 3 ? 'true' : 'false'));
    const verdict = await runPassageQuality(llm, PASSAGE);
    expect(verdict).toMatchObject({
      status: 'passed',
      true_votes: 3,
      valid_runs: 5,
      total_calls: 5,
      call_failures: 0,
      unparseable: 0,
    });
  });

  it('2 of 5 true → failed_quality', async () => {
    const llm = runner((i) => (i < 2 ? 'true' : 'false'));
    const verdict = await runPassageQuality(llm, PASSAGE);
    expect(verdict).toMatchObject({ status: 'failed_quality', true_votes: 2 });
  });

  it('tops up unparseable replies and keeps every raw response in order', async () => {
    // Calls 0 and 2 are strictness violations → 7 calls for 5 valid runs.
    const replies = [
      'True',
      'true',
      '{true}',
      'false',
      'true',
      'true',
      'false',
    ];
    const llm = runner((i) => replies[i]);
    const verdict = await runPassageQuality(llm, PASSAGE);
    expect(verdict).toMatchObject({
      status: 'passed',
      true_votes: 3,
      valid_runs: 5,
      total_calls: 7,
      unparseable: 2,
    });
    expect(verdict.runs).toEqual(replies);
  });

  it('budget spent short of 5 valid → unverified, with call-failure markers in runs', async () => {
    expect(QUALITY_MAX_CALLS).toBe(8);
    const llm = runner((i) => (i % 2 === 0 ? 'true' : null));
    const verdict = await runPassageQuality(llm, PASSAGE);
    expect(verdict).toMatchObject({
      status: 'unverified',
      valid_runs: 4,
      total_calls: 8,
      call_failures: 4,
      unparseable: 0,
    });
    expect(verdict.true_votes).toBeUndefined();
    expect(verdict.runs).toHaveLength(8);
    expect(verdict.runs[1]).toBe('[call failed: down]');
  });
});
