jest.mock('uuid', () => ({ v4: jest.fn(() => 'gen-uuid') }));

process.env.SARVAM_API_KEY = 'sarvam-key';

import type { Repository } from 'typeorm';
import { SarvamService } from './sarvam.service';
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

function makeService(repo: RepoMock): SarvamService {
  return new SarvamService(repo as unknown as Repository<MediaMetaDataEntity>);
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
}): Response {
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? '',
  } as unknown as Response;
}

const globalFetch = global.fetch;
afterEach(() => {
  global.fetch = globalFetch;
});

describe('SarvamService.run', () => {
  it('throws on empty audio buffer', async () => {
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.alloc(0), parentMedia)).rejects.toThrow(
      'Empty audio buffer',
    );
  });

  it('warns and rethrows on fetch reject (network/timeout)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('aborted'));
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'aborted',
    );
  });

  it('throws "Sarvam STT failed: NNN" on 4XX response', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 401, text: 'unauthorized' }));
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Sarvam STT failed: 401',
    );
  });

  it('throws "Sarvam STT failed: NNN" on 5XX response (separate branch)', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ status: 503, text: 'service unavail' }),
      );
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Sarvam STT failed: 503',
    );
  });

  it('happy path: saves transcript + media_details from JSON response', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: {
          request_id: 'rq-1',
          transcript: 'नमस्ते',
          language_code: 'hi-IN',
          language_probability: 0.92,
        },
      }),
    );
    const svc = makeService(makeRepo());

    const out = await svc.run(Buffer.from('audio'), parentMedia);

    expect(out.text).toBe('नमस्ते');
    expect(out.source).toBe('sarvam');
    expect(out.media_type).toBe('text');
    expect(out.status).toBe('ready');
    expect(out.input_media_id).toBe('parent-1');
    expect(out.user_id).toBe('u1');
    const details = out.media_details as {
      language_code: string;
      language_probability: number;
      sarvam_request_id: string;
    };
    expect(details.language_code).toBe('hi-IN');
    expect(details.language_probability).toBe(0.92);
    expect(details.sarvam_request_id).toBe('rq-1');
  });

  it('forwards api-subscription-key header and POSTs to sarvam endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: {
          request_id: 'rq-1',
          transcript: '',
          language_code: null,
          language_probability: null,
        },
      }),
    );
    const svc = makeService(makeRepo());

    await svc.run(Buffer.from('a'), parentMedia);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.sarvam.ai/speech-to-text');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['api-subscription-key']).toBe('sarvam-key');
  });

  it('handles null language_code / language_probability in the response', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: {
          request_id: 'rq-1',
          transcript: 'x',
          language_code: null,
          language_probability: null,
        },
      }),
    );
    const svc = makeService(makeRepo());
    const out = await svc.run(Buffer.from('a'), parentMedia);
    const details = out.media_details as {
      language_code: string | null;
      language_probability: number | null;
    };
    expect(details.language_code).toBeNull();
    expect(details.language_probability).toBeNull();
  });

  it('falls back to "audio/ogg" MIME when parent.media_details has no mime_type', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: {
          request_id: 'rq-1',
          transcript: 'x',
          language_code: null,
          language_probability: null,
        },
      }),
    );
    const svc = makeService(makeRepo());

    await svc.run(Buffer.from('a'), {
      ...parentMedia,
      media_details: null,
    } as MediaMetaData);

    // Test confirms the "?? 'audio/ogg'" branch doesn't throw. We don't
    // crack the FormData open to inspect the Blob MIME — that would couple
    // to Node WHATWG FormData internals.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts the fetch when STT_TIME_CAP elapses (real AbortController.abort branch)', async () => {
    process.env.STT_TIME_CAP = '1'; // 1s cap → 1000ms timeout
    jest.useFakeTimers();
    // fetch rejects on abort, but defer the reject to a microtask so the
    // calling code's catch handler is registered before the rejection lands.
    const fetchMock = jest.fn(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise<Response>((_, reject) => {
          init.signal.addEventListener('abort', () => {
            Promise.resolve().then(() => reject(new Error('aborted')));
          });
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = makeService(makeRepo());
    const done = svc.run(Buffer.from('a'), parentMedia);
    // Avoid Jest's unhandled-rejection guard: attach the catcher *before*
    // the timer fires.
    const settled = expect(done).rejects.toThrow('aborted');

    await jest.advanceTimersByTimeAsync(1100);
    await settled;

    jest.useRealTimers();
    delete process.env.STT_TIME_CAP;
  });

  it('STT_TIME_CAP env value is parsed and used (happy path still succeeds)', async () => {
    process.env.STT_TIME_CAP = '10';
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: {
          request_id: 'rq-1',
          transcript: 'x',
          language_code: null,
          language_probability: null,
        },
      }),
    );
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).resolves.toBeDefined();
    delete process.env.STT_TIME_CAP;
  });
});

// ─── mutation hardening ────────────────────────────────────────────────────

import { Logger as NestLogger } from '@nestjs/common';

function spyWarn() {
  return jest
    .spyOn(NestLogger.prototype, 'warn')
    .mockImplementation(() => undefined);
}

describe('SarvamService.run — exact request payload', () => {
  it('POSTs to https://api.sarvam.ai/speech-to-text with method POST + api-subscription-key header', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: {
          request_id: 'r1',
          transcript: 't',
          language_code: 'hi-IN',
          language_probability: 0.9,
        },
      }),
    );
    global.fetch = fetchSpy;
    process.env.SARVAM_API_KEY = 'sk-test';
    const svc = makeService(makeRepo());
    await svc.run(Buffer.from('a'), parentMedia);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.sarvam.ai/speech-to-text',
    );
    expect(fetchSpy.mock.calls[0][1].method).toBe('POST');
    expect(fetchSpy.mock.calls[0][1].headers['api-subscription-key']).toBe(
      'sk-test',
    );
  });

  it('forwards model="saaras:v3", mode="verbatim", language_code="hi-IN" form fields', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: {
          request_id: 'r1',
          transcript: 't',
          language_code: 'hi-IN',
          language_probability: 0.9,
        },
      }),
    );
    global.fetch = fetchSpy;
    const svc = makeService(makeRepo());
    await svc.run(Buffer.from('a'), parentMedia);
    const body = fetchSpy.mock.calls[0][1].body as FormData;
    expect(body.get('model')).toBe('saaras:v3');
    expect(body.get('mode')).toBe('verbatim');
    expect(body.get('language_code')).toBe('hi-IN');
    // file is the FormData blob; filename includes parent id + .ogg
    const file = body.get('file') as File | null;
    expect(file).toBeDefined();
    expect((file as unknown as { name: string }).name).toBe('parent-1.ogg');
  });

  it('uses parent.media_details.mime_type for the file Blob type when present', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: {
          request_id: 'r1',
          transcript: 't',
          language_code: 'hi-IN',
          language_probability: 1,
        },
      }),
    );
    global.fetch = fetchSpy;
    const svc = makeService(makeRepo());
    await svc.run(Buffer.from('a'), {
      ...parentMedia,
      media_details: { mime_type: 'audio/mp4' },
    } as MediaMetaData);
    const body = fetchSpy.mock.calls[0][1].body as FormData;
    const file = body.get('file') as Blob;
    expect(file.type).toBe('audio/mp4');
  });
});

describe('SarvamService.run — exact warn messages', () => {
  it('"Sarvam: empty audio buffer for <id>" on empty buffer', async () => {
    const warn = spyWarn();
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.alloc(0), parentMedia)).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Sarvam: empty audio buffer for parent-1',
    );
    warn.mockRestore();
  });

  it('"Sarvam: network/timeout error for <id>: <msg>" on fetch reject', async () => {
    const warn = spyWarn();
    global.fetch = jest.fn().mockRejectedValue(new Error('econn'));
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'econn',
    );
    expect(warn).toHaveBeenCalledWith(
      'Sarvam: network/timeout error for parent-1: econn',
    );
    warn.mockRestore();
  });

  it('"Sarvam 4XX for <id>: <status> <body>" on 4XX response', async () => {
    const warn = spyWarn();
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 422, text: 'bad input' }));
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Sarvam STT failed: 422',
    );
    expect(warn).toHaveBeenCalledWith('Sarvam 4XX for parent-1: 422 bad input');
    warn.mockRestore();
  });

  it('"Sarvam 5XX for <id>: <status> <body>" on 5XX response (and status === 500 hits the 5XX branch)', async () => {
    const warn = spyWarn();
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 500, text: 'oops' }));
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Sarvam STT failed: 500',
    );
    expect(warn).toHaveBeenCalledWith('Sarvam 5XX for parent-1: 500 oops');
    warn.mockRestore();
  });

  it('status 399 takes the 5XX branch (kills >=400 → > 400 boundary)', async () => {
    const warn = spyWarn();
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ status: 399, text: 'huh' }));
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Sarvam STT failed: 399',
    );
    expect(warn).toHaveBeenCalledWith('Sarvam 5XX for parent-1: 399 huh');
    warn.mockRestore();
  });
});

describe('SarvamService.run — saved row fields', () => {
  it('persists media_type=text, source=sarvam, status=ready, rolled_back=false, and links input_media_id + user_id', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: {
          request_id: 'r1',
          transcript: 'नमस्ते',
          language_code: 'hi-IN',
          language_probability: 0.91,
        },
      }),
    );
    const repo = makeRepo();
    const svc = makeService(repo);
    await svc.run(Buffer.from('a'), parentMedia);
    const created = repo.create.mock.calls[0][0] as {
      media_type: string;
      source: string;
      status: string;
      rolled_back: boolean;
      input_media_id: string;
      user_id: string;
      text: string;
      media_details: {
        language_code: string;
        language_probability: number;
        sarvam_request_id: string;
      };
    };
    expect(created.media_type).toBe('text');
    expect(created.source).toBe('sarvam');
    expect(created.status).toBe('ready');
    expect(created.rolled_back).toBe(false);
    expect(created.input_media_id).toBe('parent-1');
    expect(created.user_id).toBe('u1');
    expect(created.text).toBe('नमस्ते');
    expect(created.media_details).toEqual({
      language_code: 'hi-IN',
      language_probability: 0.91,
      sarvam_request_id: 'r1',
    });
  });
});

describe('SarvamService.run — load-test phone-prefix stub', () => {
  const PREFIX = '911000';
  const STUB_USER = `${PREFIX}123456`;
  const REAL_USER = '919999990001';

  beforeEach(() => {
    process.env.LOAD_TEST_PHONE_PREFIX = PREFIX;
  });

  afterEach(() => {
    delete process.env.LOAD_TEST_PHONE_PREFIX;
  });

  it('short-circuits Sarvam fetch and writes a canned text row when userExternalId matches', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    const repo = makeRepo();
    const svc = makeService(repo);
    const out = await svc.run(Buffer.from('a'), parentMedia, STUB_USER);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(out.source).toBe('sarvam');
    expect(out.text).toBe('<load-test stub transcript>');
  });

  it('calls Sarvam fetch when userExternalId does not match the prefix', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: {
          request_id: 'r1',
          transcript: 'real',
          language_code: 'hi-IN',
          language_probability: 0.9,
        },
      }),
    );
    global.fetch = fetchSpy as never;
    const repo = makeRepo();
    const svc = makeService(repo);
    await svc.run(Buffer.from('a'), parentMedia, REAL_USER);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
