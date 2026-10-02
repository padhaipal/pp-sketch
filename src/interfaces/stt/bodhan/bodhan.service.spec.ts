jest.mock('uuid', () => ({ v4: jest.fn(() => 'gen-uuid') }));

const recordMock = jest.fn();
jest.mock('../../../otel/metrics', () => ({
  sttRequestDuration: { record: (...a: unknown[]) => recordMock(...a) },
}));

process.env.BODHAN_API_KEY = 'bodhan-key';

import { Logger as NestLogger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import {
  BodhanService,
  BODHAN_STT_MODEL,
  BODHAN_STT_URL,
} from './bodhan.service';
import type { MediaMetaDataEntity } from '../../../media-meta-data/media-meta-data.entity';
import type { MediaMetaData } from '../../../media-meta-data/media-meta-data.dto';

type RepoMock = { create: jest.Mock; save: jest.Mock };

function makeRepo(): RepoMock {
  return {
    create: jest.fn((row) => ({ ...row })),
    save: jest
      .fn()
      .mockImplementation(async (e) => ({ ...e, created_at: new Date() })),
  };
}

function makeService(repo: RepoMock): BodhanService {
  return new BodhanService(repo as unknown as Repository<MediaMetaDataEntity>);
}

const parentMedia: MediaMetaData = {
  id: 'parent-1',
  user_id: 'u1',
  media_type: 'audio',
  source: 'whatsapp',
  status: 'ready',
  rolled_back: false,
  created_at: new Date(),
  media_details: { mime_type: 'audio/ogg' },
} as MediaMetaData;

function fakeResponse(opts: {
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}): Response {
  const headers = opts.headers ?? {};
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? '',
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

function spyWarn() {
  return jest
    .spyOn(NestLogger.prototype, 'warn')
    .mockImplementation(() => undefined);
}

const globalFetch = global.fetch;
afterEach(() => {
  global.fetch = globalFetch;
  recordMock.mockClear();
});

const outcomeOf = (call = 0) =>
  (recordMock.mock.calls[call][1] as { outcome: string }).outcome;

describe('BodhanService.run', () => {
  it('throws on empty audio buffer without recording a metric', async () => {
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.alloc(0), parentMedia)).rejects.toThrow(
      'Empty audio buffer',
    );
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('happy path: POSTs multipart to Bodhan with Bearer auth, model + language fields, saves the row', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: { text: 'नमस्ते' },
        headers: {
          'x-ratelimit-limit-requests': '8',
          'x-ratelimit-limit-parallel-requests': '2',
        },
      }),
    );
    global.fetch = fetchSpy;
    const repo = makeRepo();
    const svc = makeService(repo);

    const out = await svc.run(Buffer.from('audio'), parentMedia);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(BODHAN_STT_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer bodhan-key');
    const body = init.body as FormData;
    expect(body.get('model')).toBe(BODHAN_STT_MODEL);
    expect(body.get('language')).toBe('hi');
    const file = body.get('file') as File;
    expect(file.name).toBe('parent-1.ogg');
    expect(file.type).toBe('audio/ogg');

    expect(out.text).toBe('नमस्ते');
    expect(out.source).toBe('bodhan');
    expect(out.media_type).toBe('text');
    expect(out.status).toBe('ready');
    expect(out.input_media_id).toBe('parent-1');
    expect(out.user_id).toBe('u1');
    expect(out.rolled_back).toBe(false);
    expect(out.media_details).toEqual({
      model: 'indic-transcribe',
      language: 'hi',
      rate_limit: {
        'x-ratelimit-limit-requests': '8',
        'x-ratelimit-limit-parallel-requests': '2',
      },
    });
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(outcomeOf()).toBe('ok');
    expect(recordMock.mock.calls[0][1]).toMatchObject({ provider: 'bodhan' });
  });

  it('omits rate_limit from media_details when Bodhan sent no such headers', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 200, json: { text: 'x' } }));
    const out = await makeService(makeRepo()).run(
      Buffer.from('a'),
      parentMedia,
    );
    expect(out.media_details).toEqual({
      model: 'indic-transcribe',
      language: 'hi',
    });
  });

  it('logs the key allowance once per process (INFO), not on every call', async () => {
    const log = jest
      .spyOn(NestLogger.prototype, 'log')
      .mockImplementation(() => undefined);
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: { text: 'x' },
        headers: { 'x-ratelimit-limit-requests': '8' },
      }),
    );
    const svc = makeService(makeRepo());
    await svc.run(Buffer.from('a'), parentMedia);
    await svc.run(Buffer.from('a'), parentMedia);
    const allowance = log.mock.calls.filter((c) =>
      String(c[0]).startsWith('Bodhan: key allowance'),
    );
    expect(allowance).toHaveLength(1);
    expect(allowance[0][0]).toBe(
      'Bodhan: key allowance {"x-ratelimit-limit-requests":"8"}',
    );
    log.mockRestore();
  });

  it('falls back to audio/ogg when the parent has no mime_type', async () => {
    const fetchSpy = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 200, json: { text: 'x' } }));
    global.fetch = fetchSpy;
    await makeService(makeRepo()).run(Buffer.from('a'), {
      ...parentMedia,
      media_details: null,
    } as MediaMetaData);
    const file = (fetchSpy.mock.calls[0][1].body as FormData).get(
      'file',
    ) as Blob;
    expect(file.type).toBe('audio/ogg');
  });

  it('2XX without a text field → warns, throws, outcome error', async () => {
    const warn = spyWarn();
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 200, json: { oops: 1 } }));
    await expect(
      makeService(makeRepo()).run(Buffer.from('a'), parentMedia),
    ).rejects.toThrow('Bodhan STT failed: no text');
    expect(warn.mock.calls[0][0]).toContain(
      'Bodhan: no text in response for parent-1',
    );
    expect(outcomeOf()).toBe('error');
    warn.mockRestore();
  });

  it('429 → warns with retry-after, throws, outcome rate_limited', async () => {
    const warn = spyWarn();
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 429,
        text: '{"error":"rate limit"}',
        headers: { 'retry-after': '7' },
      }),
    );
    await expect(
      makeService(makeRepo()).run(Buffer.from('a'), parentMedia),
    ).rejects.toThrow('Bodhan STT failed: 429');
    expect(warn).toHaveBeenCalledWith(
      'Bodhan 429 for parent-1: rate-limited or out of credit (retry-after=7) {"error":"rate limit"}',
    );
    expect(outcomeOf()).toBe('rate_limited');
    warn.mockRestore();
  });

  it('415 → warns, throws, outcome rejected', async () => {
    const warn = spyWarn();
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 415, text: 'too long' }));
    await expect(
      makeService(makeRepo()).run(Buffer.from('a'), parentMedia),
    ).rejects.toThrow('Bodhan STT failed: 415');
    expect(warn).toHaveBeenCalledWith(
      'Bodhan 415 for parent-1: clip over 30s or unsupported container too long',
    );
    expect(outcomeOf()).toBe('rejected');
    warn.mockRestore();
  });

  it('other 4XX → warns with body, throws, outcome http_4xx', async () => {
    const warn = spyWarn();
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 401, text: 'bad key' }));
    await expect(
      makeService(makeRepo()).run(Buffer.from('a'), parentMedia),
    ).rejects.toThrow('Bodhan STT failed: 401');
    expect(warn).toHaveBeenCalledWith('Bodhan 4XX for parent-1: 401 bad key');
    expect(outcomeOf()).toBe('http_4xx');
    warn.mockRestore();
  });

  it('5XX → warns with body, throws, outcome http_5xx', async () => {
    const warn = spyWarn();
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 503, text: 'down' }));
    await expect(
      makeService(makeRepo()).run(Buffer.from('a'), parentMedia),
    ).rejects.toThrow('Bodhan STT failed: 503');
    expect(warn).toHaveBeenCalledWith('Bodhan 5XX for parent-1: 503 down');
    expect(outcomeOf()).toBe('http_5xx');
    warn.mockRestore();
  });

  it('fetch rejection → warns, rethrows, outcome network', async () => {
    const warn = spyWarn();
    global.fetch = jest.fn().mockRejectedValue(new Error('econn'));
    await expect(
      makeService(makeRepo()).run(Buffer.from('a'), parentMedia),
    ).rejects.toThrow('econn');
    expect(warn).toHaveBeenCalledWith(
      'Bodhan: network/timeout error for parent-1: econn',
    );
    expect(outcomeOf()).toBe('network');
    warn.mockRestore();
  });

  it('aborts at STT_TIME_CAP → outcome timeout', async () => {
    process.env.STT_TIME_CAP = '1';
    jest.useFakeTimers();
    const fetchMock = jest.fn(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise<Response>((_, reject) => {
          init.signal.addEventListener('abort', () => {
            Promise.resolve().then(() => reject(new Error('aborted')));
          });
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const warn = spyWarn();

    const done = makeService(makeRepo()).run(Buffer.from('a'), parentMedia);
    const settled = expect(done).rejects.toThrow('aborted');
    await jest.advanceTimersByTimeAsync(1100);
    await settled;

    expect(outcomeOf()).toBe('timeout');
    jest.useRealTimers();
    warn.mockRestore();
    delete process.env.STT_TIME_CAP;
  });
});

describe('BodhanService.run — load-test phone-prefix stub', () => {
  const PREFIX = '911000';

  beforeEach(() => {
    process.env.LOAD_TEST_PHONE_PREFIX = PREFIX;
  });
  afterEach(() => {
    delete process.env.LOAD_TEST_PHONE_PREFIX;
  });

  it('short-circuits the network call and writes a canned bodhan row', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    const repo = makeRepo();
    const out = await makeService(repo).run(
      Buffer.from('a'),
      parentMedia,
      `${PREFIX}123456`,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.source).toBe('bodhan');
    expect(out.text).toBe('<load-test stub transcript>');
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('calls Bodhan for a non-load-test user', async () => {
    const fetchSpy = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 200, json: { text: 'real' } }));
    global.fetch = fetchSpy as never;
    await makeService(makeRepo()).run(
      Buffer.from('a'),
      parentMedia,
      '919999990001',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
