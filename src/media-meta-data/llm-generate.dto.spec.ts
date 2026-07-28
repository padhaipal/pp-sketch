import { BadRequestException } from '@nestjs/common';
import {
  COMPREHENSION_RUNTIME_STID_RE,
  LlmOutputInvalidError,
  comprehensionCompleteStid,
  comprehensionFlowStid,
  parseGeneratedContent,
  passageLevelFromWordCount,
  validateLlmGenerateRequest,
} from './llm-generate.dto';

function validBody(): Record<string, unknown> {
  return {
    provider: 'openai',
    model: 'gpt-4.1',
    messages: [{ role: 'user', content: 'generate a passage' }],
  };
}

function validContent(): Record<string, unknown> {
  return {
    passage: { text: 'यह एक कहानी है।', passage_type: 'narrative' },
    questions: [
      {
        text: 'कहानी किस बारे में है?',
        question_type: 'retrieve',
        send_as_flow: true,
        options: [
          {
            text: 'सही उत्तर',
            correct: true,
            explanation: { text: 'यह सही है', tts: true },
          },
          {
            text: 'गलत उत्तर',
            correct: false,
            explanation: { text: 'यह गलत है', tts: false },
          },
        ],
      },
    ],
  };
}

describe('validateLlmGenerateRequest', () => {
  it('accepts a valid body', () => {
    const result = validateLlmGenerateRequest(validBody());
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4.1');
    expect(result.messages).toHaveLength(1);
  });

  it.each([
    ['null body', null],
    ['unknown provider', { ...validBody(), provider: 'krutrim' }],
    ['missing model', { ...validBody(), model: '' }],
    ['empty messages', { ...validBody(), messages: [] }],
    [
      'bad role',
      { ...validBody(), messages: [{ role: 'tool', content: 'x' }] },
    ],
    [
      'non-string content',
      { ...validBody(), messages: [{ role: 'user', content: 42 }] },
    ],
  ])('rejects %s', (_label, body) => {
    expect(() => validateLlmGenerateRequest(body)).toThrow(BadRequestException);
  });

  it('drops unknown message fields (no passthrough of untrusted keys)', () => {
    const body = validBody();
    (body.messages as Record<string, unknown>[])[0].__proto__x = 'evil';
    const result = validateLlmGenerateRequest(body);
    expect(Object.keys(result.messages[0]).sort()).toEqual(['content', 'role']);
  });
});

describe('parseGeneratedContent', () => {
  it('parses a valid completion', () => {
    const content = parseGeneratedContent(JSON.stringify(validContent()));
    expect(content.passage.passage_type).toBe('narrative');
    expect(content.questions[0].options).toHaveLength(2);
    expect(content.questions[0].options[0].correct).toBe(true);
    expect(content.questions[0].options[0].explanation.tts).toBe(true);
  });

  it('tolerates a ```json fenced block', () => {
    const raw = '```json\n' + JSON.stringify(validContent()) + '\n```';
    expect(parseGeneratedContent(raw).questions).toHaveLength(1);
  });

  it('defaults send_as_flow to true and tts to false when absent', () => {
    const value = validContent();
    const q = (value.questions as Record<string, unknown>[])[0];
    delete q.send_as_flow;
    delete (
      (q.options as Record<string, unknown>[])[1].explanation as Record<
        string,
        unknown
      >
    ).tts;
    const content = parseGeneratedContent(JSON.stringify(value));
    expect(content.questions[0].send_as_flow).toBe(true);
    expect(content.questions[0].options[1].explanation.tts).toBe(false);
  });

  it('ignores unknown keys instead of passing them through', () => {
    const value = validContent();
    value.extra = { nested: true };
    (value.passage as Record<string, unknown>).level = 99; // LLM may not set level
    const content = parseGeneratedContent(JSON.stringify(value));
    expect(
      (content as unknown as Record<string, unknown>).extra,
    ).toBeUndefined();
    expect(
      (content.passage as unknown as Record<string, unknown>).level,
    ).toBeUndefined();
  });

  it('is immune to __proto__ smuggling', () => {
    const raw =
      '{"passage":{"text":"क","passage_type":"narrative"},"__proto__":{"polluted":true},"questions":' +
      JSON.stringify(validContent().questions) +
      '}';
    const content = parseGeneratedContent(raw);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(content, 'polluted')).toBe(
      false,
    );
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['array root', '[1,2]'],
    ['missing passage', JSON.stringify({ questions: [] })],
    [
      'bad passage_type',
      JSON.stringify({
        ...validContent(),
        passage: { text: 'क', passage_type: 'poem' },
      }),
    ],
    ['no questions', JSON.stringify({ ...validContent(), questions: [] })],
    [
      'bad question_type',
      (() => {
        const v = validContent();
        (v.questions as Record<string, unknown>[])[0].question_type = 'recall';
        return JSON.stringify(v);
      })(),
    ],
    [
      'single option',
      (() => {
        const v = validContent();
        const q = (v.questions as Record<string, unknown>[])[0];
        q.options = (q.options as unknown[]).slice(0, 1);
        return JSON.stringify(v);
      })(),
    ],
    [
      'two correct options',
      (() => {
        const v = validContent();
        const q = (v.questions as Record<string, unknown>[])[0];
        (q.options as Record<string, unknown>[])[1].correct = true;
        return JSON.stringify(v);
      })(),
    ],
    [
      'option text over the flow description cap',
      (() => {
        const v = validContent();
        const q = (v.questions as Record<string, unknown>[])[0];
        (q.options as Record<string, unknown>[])[0].text = 'क'.repeat(301);
        return JSON.stringify(v);
      })(),
    ],
    [
      'control characters in passage',
      JSON.stringify({
        ...validContent(),
        passage: { text: 'कख', passage_type: 'narrative' },
      }),
    ],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseGeneratedContent(raw)).toThrow(LlmOutputInvalidError);
  });

  it('allows newlines in passage text', () => {
    const value = validContent();
    (value.passage as Record<string, unknown>).text =
      'पहली पंक्ति\nदूसरी पंक्ति';
    expect(parseGeneratedContent(JSON.stringify(value)).passage.text).toContain(
      '\n',
    );
  });
});

describe('passageLevelFromWordCount', () => {
  const words = (n: number) =>
    Array.from({ length: n }, () => 'शब्द').join(' ');

  it.each([
    [9, 8],
    [10, 9],
    [39, 9],
    [40, 10],
    [69, 10],
    [70, 11],
    [109, 11],
    [110, 12],
    [500, 12],
  ])('%d words → level %d', (count, level) => {
    expect(passageLevelFromWordCount(words(count))).toBe(level);
  });

  it('splits on Devanagari danda and punctuation', () => {
    expect(passageLevelFromWordCount('एक। दो, तीन! चार')).toBe(8);
  });
});

describe('comprehension stid helpers', () => {
  const passageId = '123e4567-e89b-42d3-a456-426614174000';

  it('builds and matches the runtime stid pair', () => {
    expect(comprehensionFlowStid(passageId)).toBe(
      `${passageId}-sentence-comprehension`,
    );
    for (const variant of ['first', 'retry']) {
      const runtime = `${passageId}-sentence-comprehension-correct-${variant}`;
      const match = COMPREHENSION_RUNTIME_STID_RE.exec(runtime);
      expect(match?.[1]).toBe(passageId);
    }
  });

  it('does not match the stored flow stid or unrelated stids', () => {
    expect(
      COMPREHENSION_RUNTIME_STID_RE.test(comprehensionFlowStid(passageId)),
    ).toBe(false);
    expect(
      COMPREHENSION_RUNTIME_STID_RE.test('घर-word-complete-correct-first'),
    ).toBe(false);
  });

  it('builds the completion stid from the answer id', () => {
    expect(comprehensionCompleteStid('opt-1')).toBe(
      'opt-1-comprehension-complete',
    );
  });
});
