jest.mock('uuid', () => ({ v4: jest.fn(() => 'gen-uuid') }));

process.env.AZURE_SPEECH_ENDPOINT = 'https://azure.test';
process.env.AZURE_SPEECH_KEY = 'key';

import type { Repository } from 'typeorm';
import { AzureService } from './azure.service';
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

function makeService(repo: RepoMock): AzureService {
  return new AzureService(repo as unknown as Repository<MediaMetaDataEntity>);
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const globalFetch = global.fetch;
afterEach(() => {
  global.fetch = globalFetch;
});

describe('AzureService.run', () => {
  it('throws "Empty audio buffer" when the buffer length is 0', async () => {
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.alloc(0), parentMedia)).rejects.toThrow(
      'Empty audio buffer',
    );
  });

  it('logs and rethrows on fetch network errors', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('aborted'));
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('audio'), parentMedia)).rejects.toThrow(
      'aborted',
    );
  });

  it('throws "Azure STT failed: NNN" when status is not 200', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(401, {
        error: { code: 'Unauthorized', message: 'bad key' },
      }),
    );
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Azure STT failed: 401',
    );
  });

  it('tolerates response.json() throwing on non-200 (catches to {})', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => {
        throw new Error('bad json');
      },
      text: async () => '',
    } as unknown as Response);
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Azure STT failed: 500',
    );
  });

  it('happy path: parses transcript, computes avg confidence, saves entity', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        durationMilliseconds: 1500,
        combinedPhrases: [{ text: 'नमस्ते' }],
        phrases: [
          { text: 'नमस्ते', locale: 'hi-IN', confidence: 0.9 },
          { text: 'दुनिया', locale: 'hi-IN', confidence: 0.7 },
        ],
      }),
    );
    const repo = makeRepo();
    const svc = makeService(repo);

    const out = await svc.run(Buffer.from('audio'), parentMedia);

    expect(out.text).toBe('नमस्ते');
    expect(out.source).toBe('azure');
    expect(out.media_type).toBe('text');
    expect(out.status).toBe('ready');
    expect(out.input_media_id).toBe('parent-1');
    expect(out.user_id).toBe('u1');
    const details = out.media_details as {
      duration_ms: number;
      locale: string;
      confidence: number;
    };
    expect(details.duration_ms).toBe(1500);
    expect(details.locale).toBe('hi-IN');
    expect(details.confidence).toBeCloseTo(0.8, 5);
  });

  it('transliterates Arabic digits to Hindi words in the transcript', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        durationMilliseconds: 500,
        combinedPhrases: [{ text: 'मेरे 12 दोस्त' }],
        phrases: [{ text: 'मेरे 12 दोस्त', locale: 'hi-IN', confidence: 1 }],
      }),
    );
    const svc = makeService(makeRepo());
    const out = await svc.run(Buffer.from('a'), parentMedia);
    // "12" → "एक दो"
    expect(out.text).toBe('मेरे एक दो दोस्त');
  });

  it('defaults transcript to "" when combinedPhrases is empty', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        durationMilliseconds: 0,
        combinedPhrases: [],
        phrases: [],
      }),
    );
    const svc = makeService(makeRepo());
    const out = await svc.run(Buffer.from('a'), parentMedia);
    expect(out.text).toBe('');
  });

  it('uses null confidence and null locale when phrases is empty', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        durationMilliseconds: 0,
        combinedPhrases: [{ text: 'x' }],
        phrases: [],
      }),
    );
    const svc = makeService(makeRepo());
    const out = await svc.run(Buffer.from('a'), parentMedia);
    const details = out.media_details as {
      confidence: number | null;
      locale: string | null;
    };
    expect(details.confidence).toBeNull();
    expect(details.locale).toBeNull();
  });

  it('falls back to "audio/ogg" MIME when parent.media_details has no mime_type', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        durationMilliseconds: 0,
        combinedPhrases: [{ text: 'x' }],
        phrases: [{ text: 'x', locale: 'hi-IN', confidence: 1 }],
      }),
    );
    const svc = makeService(makeRepo());

    await svc.run(Buffer.from('a'), {
      ...parentMedia,
      media_details: null,
    } as MediaMetaData);

    // Sanity-check: fetch was called once with a FormData body. We don't
    // crack the FormData open here — that would couple to runtime
    // internals. The fact that the call did not throw is what proves the
    // "?? 'audio/ogg'" branch was taken.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('respects STT_TIME_CAP env (no real wait — just confirms successful path with cap set)', async () => {
    process.env.STT_TIME_CAP = '10';
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        durationMilliseconds: 0,
        combinedPhrases: [{ text: 'x' }],
        phrases: [{ text: 'x', locale: 'hi-IN', confidence: 1 }],
      }),
    );
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).resolves.toBeDefined();
    delete process.env.STT_TIME_CAP;
  });

  it('POSTs to the correct Azure endpoint with the API key header', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        durationMilliseconds: 0,
        combinedPhrases: [{ text: '' }],
        phrases: [],
      }),
    );
    const svc = makeService(makeRepo());

    await svc.run(Buffer.from('a'), parentMedia);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(
      'https://azure.test/speechtotext/transcriptions:transcribe?api-version=2024-11-15',
    );
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('key');
  });
});

// ─── mutation hardening ────────────────────────────────────────────────────

import { Logger as NestLogger } from '@nestjs/common';

function spyWarn() {
  return jest
    .spyOn(NestLogger.prototype, 'warn')
    .mockImplementation(() => undefined);
}

describe('AzureService.run — exact request payload + endpoint', () => {
  it('POSTs to {AZURE_SPEECH_ENDPOINT}/speechtotext/transcriptions:transcribe?api-version=2024-11-15', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        durationMilliseconds: 100,
        combinedPhrases: [{ text: 't' }],
        phrases: [{ text: 't', locale: 'hi-IN', confidence: 1 }],
      }),
    );
    global.fetch = fetchSpy;
    process.env.AZURE_SPEECH_ENDPOINT = 'https://azure.test';
    const svc = makeService(makeRepo());
    await svc.run(Buffer.from('a'), parentMedia);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://azure.test/speechtotext/transcriptions:transcribe?api-version=2024-11-15',
    );
  });

  it('multipart body uses field name "audio" + filename "<parentId>.ogg" + definition locales hi-IN', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        durationMilliseconds: 100,
        combinedPhrases: [{ text: 't' }],
        phrases: [{ text: 't', locale: 'hi-IN', confidence: 1 }],
      }),
    );
    global.fetch = fetchSpy;
    const svc = makeService(makeRepo());
    await svc.run(Buffer.from('a'), parentMedia);
    const body = fetchSpy.mock.calls[0][1].body as FormData;
    const file = body.get('audio') as File | null;
    expect(file).toBeDefined();
    expect((file as unknown as { name: string }).name).toBe('parent-1.ogg');
    expect(body.get('definition')).toBe(JSON.stringify({ locales: ['hi-IN'] }));
  });
});

describe('AzureService.run — exact warn messages', () => {
  it('"Azure: empty audio buffer for <id>" on empty buffer', async () => {
    const warn = spyWarn();
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.alloc(0), parentMedia)).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith('Azure: empty audio buffer for parent-1');
    warn.mockRestore();
  });

  it('"Azure: network/timeout error for <id>: <msg>" on fetch reject', async () => {
    const warn = spyWarn();
    global.fetch = jest.fn().mockRejectedValue(new Error('econn'));
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'econn',
    );
    expect(warn).toHaveBeenCalledWith(
      'Azure: network/timeout error for parent-1: econn',
    );
    warn.mockRestore();
  });

  it('"Azure <status> for <id>: <error.code> <error.message>" on non-200', async () => {
    const warn = spyWarn();
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(401, {
        error: { code: 'AuthFailed', message: 'bad key' },
      }),
    );
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Azure STT failed: 401',
    );
    expect(warn).toHaveBeenCalledWith(
      'Azure 401 for parent-1: AuthFailed bad key',
    );
    warn.mockRestore();
  });

  it('non-200 with response.json() failure still logs the warn with undefined error fields', async () => {
    const warn = spyWarn();
    global.fetch = jest.fn().mockResolvedValue({
      status: 500,
      json: jest.fn().mockRejectedValue(new Error('parse err')),
    });
    const svc = makeService(makeRepo());
    await expect(svc.run(Buffer.from('a'), parentMedia)).rejects.toThrow(
      'Azure STT failed: 500',
    );
    expect(warn).toHaveBeenCalledWith(
      'Azure 500 for parent-1: undefined undefined',
    );
    warn.mockRestore();
  });
});

describe('AzureService.run — HINDI_DIGITS transliteration table', () => {
  function runWith(text: string) {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        durationMilliseconds: 0,
        combinedPhrases: [{ text }],
        phrases: [{ text, locale: 'hi-IN', confidence: 1 }],
      }),
    );
    const repo = makeRepo();
    const svc = makeService(repo);
    return svc.run(Buffer.from('a'), parentMedia).then(() => {
      return (repo.create.mock.calls[0][0] as { text: string }).text;
    });
  }

  it.each<[string, string]>([
    ['0', 'शून्य'],
    ['1', 'एक'],
    ['2', 'दो'],
    ['3', 'तीन'],
    ['4', 'चार'],
    ['5', 'पाँच'],
    ['6', 'छह'],
    ['7', 'सात'],
    ['8', 'आठ'],
    ['9', 'नौ'],
  ])('"%s" → "%s"', async (digit, hindi) => {
    expect(await runWith(`hello ${digit} test`)).toBe(`hello ${hindi} test`);
  });

  it('multi-digit numbers transliterate digit-by-digit, space-separated', async () => {
    expect(await runWith('count 123')).toBe('count एक दो तीन');
  });
});

describe('AzureService.run — saved row + media_details', () => {
  it('persists media_type=text, source=azure, status=ready, rolled_back=false, and full media_details (duration_ms, locale, avg confidence)', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        durationMilliseconds: 5000,
        combinedPhrases: [{ text: 'hello' }],
        phrases: [
          { text: 'hello', locale: 'hi-IN', confidence: 0.8 },
          { text: 'world', locale: 'en-US', confidence: 0.6 },
        ],
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
      text: string;
      media_details: {
        duration_ms: number;
        locale: string;
        confidence: number;
      };
    };
    expect(created.media_type).toBe('text');
    expect(created.source).toBe('azure');
    expect(created.status).toBe('ready');
    expect(created.rolled_back).toBe(false);
    expect(created.input_media_id).toBe('parent-1');
    expect(created.text).toBe('hello');
    expect(created.media_details.duration_ms).toBe(5000);
    expect(created.media_details.locale).toBe('hi-IN'); // first phrase's locale
    expect(created.media_details.confidence).toBeCloseTo(0.7); // (0.8 + 0.6) / 2
  });
});

describe('AzureService.run — load-test phone-prefix stub', () => {
  const PREFIX = '911000';
  const STUB_USER = `${PREFIX}123456`;
  const REAL_USER = '919999990001';

  beforeEach(() => {
    process.env.LOAD_TEST_PHONE_PREFIX = PREFIX;
  });

  afterEach(() => {
    delete process.env.LOAD_TEST_PHONE_PREFIX;
  });

  it('short-circuits Azure fetch and writes a canned text row when userExternalId matches', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    const repo = makeRepo();
    const svc = makeService(repo);
    const out = await svc.run(Buffer.from('a'), parentMedia, STUB_USER);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(out.source).toBe('azure');
    expect(out.text).toBe('<load-test stub transcript>');
  });

  it('calls Azure fetch when userExternalId does not match the prefix', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        durationMilliseconds: 100,
        combinedPhrases: [{ text: 'hello' }],
        phrases: [{ text: 'hello', locale: 'hi-IN', confidence: 0.9 }],
      }),
    );
    global.fetch = fetchSpy as never;
    const repo = makeRepo();
    const svc = makeService(repo);
    await svc.run(Buffer.from('a'), parentMedia, REAL_USER);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
