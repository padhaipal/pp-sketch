process.env.TEST_API_KEY = 'test-key';
process.env.LLM_TIME_CAP = '45';

import { callChatCompletions, runCompletionBatch } from './llm-client';
import { LlmError, LlmProviderConfig, LlmRequest } from './llm.dto';

const config: LlmProviderConfig = {
  provider: 'openai',
  baseUrl: 'https://example.test/v1',
  envKey: 'TEST_API_KEY',
};

const request: LlmRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
};

// options that keep retries instant in tests
const fast = { baseBackoffMs: 1 };

function fakeResponse(opts: {
  status: number;
  json?: unknown;
  text?: string;
  retryAfter?: string;
}): Response {
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? '',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'retry-after' ? (opts.retryAfter ?? null) : null,
    },
  } as unknown as Response;
}

function okResponse(text = 'hello'): Response {
  return fakeResponse({
    status: 200,
    json: {
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  });
}

const globalFetch = global.fetch;
afterEach(() => {
  global.fetch = globalFetch;
  jest.restoreAllMocks();
});

describe('callChatCompletions', () => {
  it('returns text and token usage on success', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse('answer'));
    const result = await callChatCompletions(config, request, fast);
    expect(result.text).toBe('answer');
    expect(result.model).toBe('test-model');
    expect(result.prompt_tokens).toBe(10);
    expect(result.completion_tokens).toBe(5);
    expect(typeof result.duration_ms).toBe('number');
  });

  it('sends the auth header with the Bearer prefix by default', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock;
    await callChatCompletions(config, request, fast);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-key',
    );
  });

  it('supports custom auth header, prefix and extraBody', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock;
    const sarvamLike: LlmProviderConfig = {
      ...config,
      provider: 'sarvam',
      authHeader: 'api-subscription-key',
      authPrefix: '',
      extraBody: { reasoning_effort: null },
    };
    await callChatCompletions(sarvamLike, request, fast);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(
      (init.headers as Record<string, string>)['api-subscription-key'],
    ).toBe('test-key');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeNull();
  });

  it('passes max_tokens and temperature through when set', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock;
    await callChatCompletions(
      config,
      { ...request, max_tokens: 100, temperature: 0.5 },
      fast,
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.5);
  });

  it('throws non-retriable when the API key env var is missing', async () => {
    global.fetch = jest.fn();
    const badConfig = { ...config, envKey: 'DEFINITELY_UNSET_KEY' };
    const err = await callChatCompletions(badConfig, request, fast).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).retriable).toBe(false);
    expect((err as LlmError).message).toContain('DEFINITELY_UNSET_KEY');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not retry on non-429 4xx', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 400, text: 'bad request' }));
    global.fetch = fetchMock;
    const err = await callChatCompletions(config, request, fast).catch(
      (e: unknown) => e,
    );
    expect((err as LlmError).retriable).toBe(false);
    expect((err as LlmError).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 429 then succeeds', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({ status: 429, text: 'slow down', retryAfter: '0' }),
      )
      .mockResolvedValueOnce(okResponse('second try'));
    global.fetch = fetchMock;
    const result = await callChatCompletions(config, request, fast);
    expect(result.text).toBe('second try');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries 5xx up to maxAttempts then throws retriable', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 503, text: 'down' }));
    global.fetch = fetchMock;
    const err = await callChatCompletions(config, request, {
      ...fast,
      maxAttempts: 3,
    }).catch((e: unknown) => e);
    expect((err as LlmError).retriable).toBe(true);
    expect((err as LlmError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('normalizes network errors to retriable LlmError', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('socket hang up'));
    global.fetch = fetchMock;
    const err = await callChatCompletions(config, request, {
      ...fast,
      maxAttempts: 2,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).retriable).toBe(true);
    expect((err as LlmError).message).toContain('socket hang up');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws non-retriable on an empty completion', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: { choices: [{ message: { content: '' } }] },
      }),
    );
    const err = await callChatCompletions(config, request, fast).catch(
      (e: unknown) => e,
    );
    expect((err as LlmError).retriable).toBe(false);
    expect((err as LlmError).message).toContain('empty completion');
  });
});

describe('runCompletionBatch', () => {
  it('returns index-aligned results and isolates per-item failures', async () => {
    const fetchMock = jest
      .fn()
      .mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          messages: { content: string }[];
        };
        if (body.messages[0].content === 'fail') {
          return fakeResponse({ status: 400, text: 'nope' });
        }
        return okResponse(`echo:${body.messages[0].content}`);
      });
    global.fetch = fetchMock;

    const requests: LlmRequest[] = ['a', 'fail', 'b'].map((content) => ({
      model: 'test-model',
      messages: [{ role: 'user', content }],
    }));
    const items = await runCompletionBatch(config, requests, fast);

    expect(items).toHaveLength(3);
    expect(items[0].result?.text).toBe('echo:a');
    expect(items[1].result).toBeNull();
    expect(items[1].error?.retriable).toBe(false);
    expect(items[2].result?.text).toBe('echo:b');
  });

  it('respects the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return okResponse();
    });

    const requests: LlmRequest[] = Array.from({ length: 10 }, () => request);
    await runCompletionBatch(config, requests, { ...fast, concurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('handles an empty request list', async () => {
    global.fetch = jest.fn();
    const items = await runCompletionBatch(config, [], fast);
    expect(items).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
