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
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({ ok: true, body: {} }),
    );

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
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({ ok: true, body: {} }),
    );
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
    global.fetch = jest.fn().mockResolvedValue(
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
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 502, text: 'gw' }),
    );
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
    global.fetch = jest.fn().mockResolvedValue(
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
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({ ok: true, body: {} }),
    );
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
