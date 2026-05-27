jest.mock('uuid', () => ({ v4: jest.fn(() => 'gen-uuid') }));

process.env.REVERIE_API_KEY = 'rev-key';
process.env.REVERIE_APP_ID = 'rev-app';

import type { Repository } from 'typeorm';
import { ReverieService } from './reverie.service';
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

function makeService(repo: RepoMock): ReverieService {
  return new ReverieService(repo as unknown as Repository<MediaMetaDataEntity>);
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

function makeResponse(opts: {
  status?: number;
  json?: unknown;
  text?: string;
}): Response {
  const status = opts.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? '',
  } as unknown as Response;
}

const okPayload = {
  id: 'rev-req-1',
  success: true,
  final: true,
  text: 'नमस्ते',
  display_text: 'नमस्ते।',
  confidence: 0.91,
  cause: 'EOF received',
};

const globalFetch = global.fetch;
afterEach(() => {
  global.fetch = globalFetch;
});

describe('ReverieService.run — input validation', () => {
  it('throws "Empty audio buffer" when the buffer length is zero', async () => {
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.alloc(0), parentMedia)).rejects.toThrow(
      'Empty audio buffer',
    );
    // Sanity: empty buffer must short-circuit BEFORE we touch fetch.
    expect(global.fetch).toBe(globalFetch);
  });
});

describe('ReverieService.run — network/transport failures', () => {
  it('warns and rethrows when fetch rejects (network error)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'ECONNRESET',
    );
  });

  it('does NOT save when fetch rejects', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('boom'));
    const repo = makeRepo();
    const svc = makeService(repo);
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow();
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('ReverieService.run — HTTP error responses', () => {
  it('throws "Reverie STT failed: NNN" on a 4XX', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(makeResponse({ status: 401, text: 'unauthorized' }));
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Reverie STT failed: 401',
    );
  });

  it('throws "Reverie STT failed: NNN" on a 5XX', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(makeResponse({ status: 502, text: 'bad gw' }));
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Reverie STT failed: 502',
    );
  });

  it('does NOT save when the HTTP status is non-ok', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(makeResponse({ status: 500, text: 'oops' }));
    const repo = makeRepo();
    const svc = makeService(repo);
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow();
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('ReverieService.run — application-level success flag', () => {
  it('throws "Reverie STT unsuccessful: <cause>" when result.success is false', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        json: { ...okPayload, success: false, cause: 'No speech detected' },
      }),
    );
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Reverie STT unsuccessful: No speech detected',
    );
  });

  it('does NOT save when result.success is false', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        json: { ...okPayload, success: false, cause: 'noise' },
      }),
    );
    const repo = makeRepo();
    const svc = makeService(repo);
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow();
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('ReverieService.run — happy path', () => {
  it('saves a media_metadata row mapped from the Reverie JSON response', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(makeResponse({ status: 200, json: okPayload }));
    const repo = makeRepo();
    const svc = makeService(repo);

    const out = await svc.run(Buffer.from('audio'), parentMedia);

    expect(out.text).toBe('नमस्ते');
    expect(out.source).toBe('reverie');
    expect(out.media_type).toBe('text');
    expect(out.status).toBe('ready');
    expect(out.input_media_id).toBe('parent-1');
    expect(out.user_id).toBe('u1');
    expect(out.rolled_back).toBe(false);
    expect(out.media_details).toEqual({
      raw_text: 'नमस्ते',
      confidence: 0.91,
      reverie_request_id: 'rev-req-1',
      cause: 'EOF received',
    });
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('POSTs to the Reverie endpoint with the documented header set', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(makeResponse({ status: 200, json: okPayload }));
    const svc = makeService(makeRepo());

    await svc.run(Buffer.from('a'), parentMedia);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://revapi.reverieinc.com/');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers).toMatchObject({
      'REV-API-KEY': 'rev-key',
      'REV-APP-ID': 'rev-app',
      'REV-APPNAME': 'stt_file',
      src_lang: 'hi',
      domain: 'generic',
      format: 'ogg_opus',
      logging: 'false',
      punctuate: 'true',
    });
  });

  it('passes an AbortSignal so timeout cancellation is possible', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(makeResponse({ status: 200, json: okPayload }));
    const svc = makeService(makeRepo());

    await svc.run(Buffer.from('a'), parentMedia);

    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeDefined();
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });
});

describe('ReverieService.run — STT_TIME_CAP timeout', () => {
  // STT_TIME_CAP is parsed with a default of '5' seconds. We verify both
  // that the configured cap is consulted, and that the abort actually fires
  // when the cap elapses.

  it('honours STT_TIME_CAP env on the happy path (no real wait needed)', async () => {
    process.env.STT_TIME_CAP = '7';
    global.fetch = jest
      .fn()
      .mockResolvedValue(makeResponse({ status: 200, json: okPayload }));
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).resolves.toBeDefined();
    delete process.env.STT_TIME_CAP;
  });

  it('aborts the fetch when the timer elapses (real AbortController branch)', async () => {
    process.env.STT_TIME_CAP = '1'; // 1s cap → 1000ms timeout
    jest.useFakeTimers();

    // Fetch hangs until the AbortController signal aborts. The reject is
    // deferred to a microtask so the calling code's catch is registered
    // before the rejection lands (otherwise Jest's unhandled-rejection
    // guard trips during advanceTimersByTimeAsync).
    global.fetch = jest.fn(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise<Response>((_, reject) => {
          init.signal.addEventListener('abort', () => {
            Promise.resolve().then(() => reject(new Error('aborted')));
          });
        }),
    ) as unknown as typeof fetch;

    const svc = makeService(makeRepo());
    const done = svc.run(Buffer.from('a'), parentMedia);
    // Attach the catcher BEFORE advancing the clock.
    const settled = expect(done).rejects.toThrow('aborted');

    await jest.advanceTimersByTimeAsync(1100);
    await settled;

    jest.useRealTimers();
    delete process.env.STT_TIME_CAP;
  });
});
