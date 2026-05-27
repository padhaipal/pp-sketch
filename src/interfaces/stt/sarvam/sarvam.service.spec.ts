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
    save: jest.fn().mockImplementation(async (e) => ({ ...e, created_at: new Date() })),
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
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({ status: 401, text: 'unauthorized' }),
    );
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Sarvam STT failed: 401',
    );
  });

  it('throws "Sarvam STT failed: NNN" on 5XX response (separate branch)', async () => {
    global.fetch = jest.fn().mockResolvedValue(
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
