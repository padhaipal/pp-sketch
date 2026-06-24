const mockQueueAdd = jest.fn();
const mockCreateQueue = jest.fn(() => ({ add: mockQueueAdd }));
jest.mock('../../redis/queues', () => ({
  createQueue: (...args: unknown[]) => mockCreateQueue(...args),
  QUEUE_NAMES: { WHATSAPP_PRELOAD: 'whatsapp-preload' },
}));

const mockSpanEnd = jest.fn();
const mockStartChildSpan = jest.fn(() => ({ end: mockSpanEnd }));
const mockInjectCarrier = jest.fn(() => ({ traceparent: 'tp' }));
jest.mock('../../../otel/otel', () => ({
  startChildSpan: (...args: unknown[]) => mockStartChildSpan(...args),
  injectCarrier: (...args: unknown[]) => mockInjectCarrier(...args),
}));

const mockIsLoadTestCarrier = jest.fn().mockReturnValue(false);
jest.mock('../../../otel/load-test-context', () => ({
  isLoadTestCarrier: (...args: unknown[]) => mockIsLoadTestCarrier(...args),
}));

jest.mock('stream', () => {
  const actual = jest.requireActual('stream');
  return {
    ...actual,
    Readable: { ...actual.Readable, fromWeb: jest.fn((body) => body) },
  };
});

process.env.ELEVENLABS_API_KEY = 'test-key';
process.env.ELEVENLABS_VOICE_ID = 'env-voice';

import type { Job } from 'bullmq';
import type { Repository } from 'typeorm';
import type { MediaBucketService } from '../../media-bucket/outbound/outbound.service';
import type { MediaMetaDataEntity } from '../../../media-meta-data/media-meta-data.entity';
import {
  ElevenlabsGenerateJobData,
  processElevenlabsGenerateJob,
} from './outbound.service';

type RepoMock = { update: jest.Mock };
type BucketMock = { stream: jest.Mock };

function makeRepo(): RepoMock {
  return { update: jest.fn().mockResolvedValue({ affected: 1 }) };
}
function makeBucket(): BucketMock {
  return { stream: jest.fn().mockResolvedValue('s3/key.mp3') };
}

function makeJob(
  params: Partial<ElevenlabsGenerateJobData['elevenlabs_params']> = {},
  opts: { attemptsMade?: number; attempts?: number } = {},
): Job<ElevenlabsGenerateJobData> {
  return {
    data: {
      media_metadata_id: 'mm-1',
      otel_carrier: { traceparent: 'parent' } as never,
      elevenlabs_params: { script_text: 'hello', ...params },
    },
    attemptsMade: opts.attemptsMade ?? 0,
    opts: { attempts: opts.attempts ?? 3 },
  } as unknown as Job<ElevenlabsGenerateJobData>;
}

function fakeResponse(opts: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Response {
  const status = opts.status ?? 200;
  return {
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    headers: {
      get: (k: string) => opts.headers?.[k.toLowerCase()] ?? null,
    },
    body: opts.body ?? null,
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? '',
  } as unknown as Response;
}

const globalFetch = global.fetch;

beforeEach(() => {
  mockQueueAdd.mockReset().mockResolvedValue(undefined);
  mockSpanEnd.mockReset();
  mockStartChildSpan.mockClear();
  mockInjectCarrier.mockClear();
  mockIsLoadTestCarrier.mockReset().mockReturnValue(false);
});
afterEach(() => {
  global.fetch = globalFetch;
});

describe('processElevenlabsGenerateJob — 200 OK', () => {
  it('streams audio to S3, updates row with queued status, enqueues preload', async () => {
    const audioBody = { kind: 'webstream' };
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        ok: true,
        body: audioBody,
        headers: { 'content-length': '8421' },
      }),
    );
    const repo = makeRepo();
    const bucket = makeBucket();

    await processElevenlabsGenerateJob(
      makeJob(),
      bucket as unknown as MediaBucketService,
      repo as unknown as Repository<MediaMetaDataEntity>,
    );

    // URL uses env default voice + correct query
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/env-voice?output_format=mp3_44100_128',
    );
    expect((init as RequestInit).method).toBe('POST');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual({ text: 'hello' }); // no optionals set

    expect(bucket.stream).toHaveBeenCalledWith(audioBody, 'audio/mpeg');
    expect(repo.update).toHaveBeenCalledWith('mm-1', {
      s3_key: 's3/key.mp3',
      media_details: { mime_type: 'audio/mpeg', byte_size: 8421 },
      status: 'queued',
    });
    expect(mockQueueAdd).toHaveBeenCalledWith('preload-mm-1', {
      media_metadata_id: 'mm-1',
      s3_key: 's3/key.mp3',
      otel_carrier: { traceparent: 'tp' },
    });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('uses caller-supplied voice_id (URL-encoded) and forwards all optional TTS params', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ ok: true, body: {} }));

    await processElevenlabsGenerateJob(
      makeJob({
        voice_id: 'voice with/space',
        model_id: 'm-1',
        language_code: 'hi',
        voice_settings: { stability: 0.5, similarity_boost: 0.7 } as never,
      }),
      makeBucket() as unknown as MediaBucketService,
      makeRepo() as unknown as Repository<MediaMetaDataEntity>,
    );

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice%20with%2Fspace?output_format=mp3_44100_128',
    );
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual({
      text: 'hello',
      model_id: 'm-1',
      language_code: 'hi',
      voice_settings: { stability: 0.5, similarity_boost: 0.7 },
    });
  });

  it('sets byte_size to null when Content-Length header is absent', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ ok: true, body: {} }));
    const repo = makeRepo();

    await processElevenlabsGenerateJob(
      makeJob(),
      makeBucket() as unknown as MediaBucketService,
      repo as unknown as Repository<MediaMetaDataEntity>,
    );

    const details = (
      repo.update.mock.calls[0][1] as {
        media_details: { byte_size: number | null };
      }
    ).media_details;
    expect(details.byte_size).toBeNull();
  });
});

describe('processElevenlabsGenerateJob — 4XX', () => {
  it('writes failed + error body, throws "ElevenLabs TTS NNN"', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 422,
        json: { detail: 'bad voice' },
      }),
    );
    const repo = makeRepo();

    await expect(
      processElevenlabsGenerateJob(
        makeJob(),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('ElevenLabs TTS 422');

    expect(repo.update).toHaveBeenCalledWith('mm-1', {
      status: 'failed',
      media_details: { error: { detail: 'bad voice' } },
    });
  });
});

describe('processElevenlabsGenerateJob — 5XX', () => {
  it('non-final attempt: does NOT mark failed, just throws', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 503, text: 'unavail' }),
      );
    const repo = makeRepo();

    await expect(
      processElevenlabsGenerateJob(
        makeJob({}, { attemptsMade: 0, attempts: 3 }),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('ElevenLabs TTS 5XX: 503');

    expect(repo.update).not.toHaveBeenCalled();
  });

  it('final attempt: marks failed and throws', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ ok: false, status: 502, text: 'gw' }));
    const repo = makeRepo();

    await expect(
      processElevenlabsGenerateJob(
        makeJob({}, { attemptsMade: 2, attempts: 3 }),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('ElevenLabs TTS 5XX: 502');

    expect(repo.update).toHaveBeenCalledWith('mm-1', {
      status: 'failed',
      media_details: { error: 'gw' },
    });
  });

  it('treats single attempt as final when opts.attempts is undefined', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 500, text: 'oops' }),
      );
    const repo = makeRepo();

    await expect(
      processElevenlabsGenerateJob(
        {
          data: {
            media_metadata_id: 'mm-1',
            otel_carrier: { traceparent: 'parent' } as never,
            elevenlabs_params: { script_text: 'hello' },
          },
          attemptsMade: 0,
          opts: {},
        } as unknown as Job<ElevenlabsGenerateJobData>,
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('ElevenLabs TTS 5XX: 500');

    expect(repo.update).toHaveBeenCalled();
  });
});

describe('processElevenlabsGenerateJob — outer error handling', () => {
  it('ends span and rethrows when fetch itself rejects', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('netfail'));
    const repo = makeRepo();

    await expect(
      processElevenlabsGenerateJob(
        makeJob(),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('netfail');

    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('opens the child span with the carrier from job.data', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ ok: true, body: {} }));
    await processElevenlabsGenerateJob(
      makeJob(),
      makeBucket() as unknown as MediaBucketService,
      makeRepo() as unknown as Repository<MediaMetaDataEntity>,
    );
    expect(mockStartChildSpan).toHaveBeenCalledWith(
      'elevenlabs-generate-processor',
      { traceparent: 'parent' },
    );
  });
});

// ─── mutation hardening ────────────────────────────────────────────────────

import { Logger as NestLogger } from '@nestjs/common';

function spyELabsLog() {
  return {
    warn: jest
      .spyOn(NestLogger.prototype, 'warn')
      .mockImplementation(() => undefined),
    error: jest
      .spyOn(NestLogger.prototype, 'error')
      .mockImplementation(() => undefined),
  };
}

describe('processElevenlabsGenerateJob — exact request shape + log messages', () => {
  it('POST uses Content-Type application/json header', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream(),
      headers: { get: () => '1024' },
    });
    global.fetch = fetchSpy as never;
    const mediaBucket = {
      stream: jest.fn().mockResolvedValue('s3/k'),
    } as never;
    const mediaRepo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never;
    await processElevenlabsGenerateJob(
      makeJob({ script_text: 'hi' }),
      mediaBucket,
      mediaRepo,
    );
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('omits model_id / language_code / voice_settings from the body when they are undefined', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream(),
      headers: { get: () => null },
    });
    global.fetch = fetchSpy as never;
    const mediaBucket = {
      stream: jest.fn().mockResolvedValue('s3/k'),
    } as never;
    const mediaRepo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never;
    await processElevenlabsGenerateJob(
      makeJob({ script_text: 'hi' }),
      mediaBucket,
      mediaRepo,
    );
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ text: 'hi' });
    expect(body).not.toHaveProperty('model_id');
    expect(body).not.toHaveProperty('language_code');
    expect(body).not.toHaveProperty('voice_settings');
  });

  it('on 4XX error: log "ElevenLabs TTS <status>: <body-json>"', async () => {
    const { error } = spyELabsLog();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: 'bad input' }),
    }) as never;
    const mediaRepo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never;
    await expect(
      processElevenlabsGenerateJob(
        makeJob({ script_text: 'hi' }),
        { stream: jest.fn() } as never,
        mediaRepo,
      ),
    ).rejects.toThrow('ElevenLabs TTS 422');
    expect(error).toHaveBeenCalledWith(
      'ElevenLabs TTS 422: {"message":"bad input"}',
    );
    error.mockRestore();
  });

  it('on 5XX final attempt: error "ElevenLabs TTS 5XX (final attempt): <body>"', async () => {
    const { error } = spyELabsLog();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'upstream down',
    }) as never;
    const mediaRepo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    } as never;
    const job = makeJob(
      { script_text: 'hi' },
      { attemptsMade: 2, attempts: 3 },
    );
    await expect(
      processElevenlabsGenerateJob(
        job,
        { stream: jest.fn() } as never,
        mediaRepo,
      ),
    ).rejects.toThrow(/ElevenLabs TTS 5XX: 502/);
    expect(error).toHaveBeenCalledWith(
      'ElevenLabs TTS 5XX (final attempt): upstream down',
    );
    error.mockRestore();
  });

  it('on 5XX non-final attempt: warn "ElevenLabs TTS 5XX (attempt <1-based>): <body>"', async () => {
    const { warn } = spyELabsLog();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'upstream down',
    }) as never;
    const mediaRepo = { update: jest.fn() } as never;
    const job = makeJob(
      { script_text: 'hi' },
      { attemptsMade: 0, attempts: 3 },
    );
    await expect(
      processElevenlabsGenerateJob(
        job,
        { stream: jest.fn() } as never,
        mediaRepo,
      ),
    ).rejects.toThrow(/ElevenLabs TTS 5XX: 502/);
    expect(warn).toHaveBeenCalledWith(
      'ElevenLabs TTS 5XX (attempt 1): upstream down',
    );
    warn.mockRestore();
  });

  it('status 399 (boundary) goes to 5XX branch (kills <500 → <=)', async () => {
    const { warn } = spyELabsLog();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 399,
      text: async () => 'odd',
    }) as never;
    const mediaRepo = { update: jest.fn() } as never;
    const job = makeJob(
      { script_text: 'hi' },
      { attemptsMade: 0, attempts: 3 },
    );
    await expect(
      processElevenlabsGenerateJob(
        job,
        { stream: jest.fn() } as never,
        mediaRepo,
      ),
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith('ElevenLabs TTS 5XX (attempt 1): odd');
    warn.mockRestore();
  });
});

// The ElevenLabs processor short-circuits when the propagated carrier carries
// padhaipal.load_test=true, marking the row 'failed' with a load_test_stub
// flag and skipping the API call + preload enqueue entirely. When the
// helper returns false (no baggage, no carrier, or load_test='false') the
// real fetch path runs — this is the "let it pass" semantic.
describe('processElevenlabsGenerateJob — load-test stub', () => {
  it('short-circuits when isLoadTestCarrier returns true: no fetch, no preload enqueue, row marked failed with stub flag', async () => {
    mockIsLoadTestCarrier.mockReturnValueOnce(true);
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    const repo = makeRepo();
    const bucket = makeBucket();

    await processElevenlabsGenerateJob(
      makeJob(),
      bucket as unknown as MediaBucketService,
      repo as unknown as Repository<MediaMetaDataEntity>,
    );

    expect(mockIsLoadTestCarrier).toHaveBeenCalledWith({
      traceparent: 'parent',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith('mm-1', {
      status: 'failed',
      media_details: { load_test_stub: true },
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('proceeds with real fetch when isLoadTestCarrier returns false (default)', async () => {
    // default mock value is false — no override needed
    const audioBody = { kind: 'webstream' };
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        ok: true,
        body: audioBody,
        headers: { 'content-length': '8421' },
      }),
    );
    const repo = makeRepo();
    const bucket = makeBucket();

    await processElevenlabsGenerateJob(
      makeJob(),
      bucket as unknown as MediaBucketService,
      repo as unknown as Repository<MediaMetaDataEntity>,
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it('does NOT throw when isLoadTestCarrier returns true (BullMQ must not retry the stub)', async () => {
    mockIsLoadTestCarrier.mockReturnValueOnce(true);
    global.fetch = jest.fn() as never;
    const repo = makeRepo();
    const bucket = makeBucket();

    await expect(
      processElevenlabsGenerateJob(
        makeJob(),
        bucket as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).resolves.toBeUndefined();
  });
});
