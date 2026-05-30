// Module-load side effects to suppress:
//   - createQueue() in ../../redis/queues opens a Redis socket
//   - startChildSpan / injectCarrier in otel.ts pulls the full SDK
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

// Readable.fromWeb pulls in real web streams — bypass it.
jest.mock('stream', () => {
  const actual = jest.requireActual('stream');
  return {
    ...actual,
    Readable: { ...actual.Readable, fromWeb: jest.fn((body) => body) },
  };
});

// Force env values so HEYGEN_API_KEY etc. aren't `undefined!`.
process.env.HEYGEN_API_KEY = 'test-key';
process.env.HEYGEN_AVATAR_ID = 'env-avatar';
process.env.HEYGEN_VOICE_ID = 'env-voice';
process.env.HEYGEN_CALLBACK_URL = 'https://cb.example/heygen';

import type { Job } from 'bullmq';
import {
  HeygenGenerateJobData,
  processHeygenGenerateJob,
} from './outbound.service';
import type { Repository } from 'typeorm';
import type { MediaBucketService } from '../../media-bucket/outbound/outbound.service';
import type { MediaMetaDataEntity } from '../../../media-meta-data/media-meta-data.entity';

type RepoMock = { update: jest.Mock };
type BucketMock = { stream: jest.Mock };

function makeRepo(): RepoMock {
  return { update: jest.fn().mockResolvedValue({ affected: 1 }) };
}
function makeBucket(): BucketMock {
  return { stream: jest.fn().mockResolvedValue('s3/key/x.mp3') };
}

function makeJob(
  data: HeygenGenerateJobData,
  opts: { attemptsMade?: number; attempts?: number } = {},
): Job<HeygenGenerateJobData> {
  return {
    data,
    attemptsMade: opts.attemptsMade ?? 0,
    opts: { attempts: opts.attempts ?? 3 },
  } as unknown as Job<HeygenGenerateJobData>;
}

function videoData(
  overrides: Partial<HeygenGenerateJobData['heygen_params']> = {},
): HeygenGenerateJobData {
  return {
    media_metadata_id: 'mm-1',
    media_type: 'video',
    otel_carrier: { traceparent: 'parent' } as never,
    heygen_params: { script_text: 'hello', ...overrides },
  };
}

function audioData(
  overrides: Partial<HeygenGenerateJobData['heygen_params']> = {},
): HeygenGenerateJobData {
  return {
    media_metadata_id: 'mm-2',
    media_type: 'audio',
    otel_carrier: { traceparent: 'parent' } as never,
    heygen_params: { script_text: 'hello', ...overrides },
  };
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
  const headers = {
    get: (k: string) => opts.headers?.[k.toLowerCase()] ?? null,
  };
  return {
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    headers,
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

describe('processHeygenGenerateJob — video branch', () => {
  it('200 OK: updates media row with video_id + queued and ends span', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: true, json: { data: { video_id: 'vid-42' } } }),
      );
    const repo = makeRepo();
    const bucket = makeBucket();

    await processHeygenGenerateJob(
      makeJob(videoData()),
      bucket as unknown as MediaBucketService,
      repo as unknown as Repository<MediaMetaDataEntity>,
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.heygen.com/v2/video/generate');
    expect((init as RequestInit).method).toBe('POST');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.video_inputs[0].character.avatar_id).toBe('env-avatar'); // default
    expect(sent.video_inputs[0].character.avatar_style).toBe('normal'); // default
    expect(sent.video_inputs[0].voice.voice_id).toBe('env-voice'); // default
    expect(sent.callback_url).toBe('https://cb.example/heygen');
    expect(sent.dimension).toEqual({ width: 1920, height: 1080 }); // default
    expect(repo.update).toHaveBeenCalledWith('mm-1', {
      media_details: { video_id: 'vid-42' },
      status: 'queued',
    });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('200 OK: passes through caller-supplied avatar/voice/style/background/dimension', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: true, json: { data: { video_id: 'vid-42' } } }),
      );
    const repo = makeRepo();

    await processHeygenGenerateJob(
      makeJob(
        videoData({
          avatar_id: 'custom-av',
          avatar_style: 'circle',
          voice_id: 'custom-voice',
          speed: 1.2,
          emotion: 'Excited',
          locale: 'en-IN',
          background: { type: 'color', value: '#fff' },
          title: 'my-vid',
          dimension: { width: 720, height: 1280 },
        }),
      ),
      makeBucket() as unknown as MediaBucketService,
      repo as unknown as Repository<MediaMetaDataEntity>,
    );

    const sent = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(sent.video_inputs[0].character.avatar_id).toBe('custom-av');
    expect(sent.video_inputs[0].character.avatar_style).toBe('circle');
    expect(sent.video_inputs[0].voice.voice_id).toBe('custom-voice');
    expect(sent.video_inputs[0].voice.speed).toBe(1.2);
    expect(sent.video_inputs[0].voice.emotion).toBe('Excited');
    expect(sent.video_inputs[0].voice.locale).toBe('en-IN');
    expect(sent.video_inputs[0].background).toEqual({
      type: 'color',
      value: '#fff',
    });
    expect(sent.title).toBe('my-vid');
    expect(sent.dimension).toEqual({ width: 720, height: 1280 });
  });

  it('4XX: writes failed + error, throws "HeyGen 4XX:N"', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 422,
        json: { error: { code: 'BAD', message: 'bad' } },
      }),
    );
    const repo = makeRepo();

    await expect(
      processHeygenGenerateJob(
        makeJob(videoData()),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('HeyGen 4XX: 422');

    expect(repo.update).toHaveBeenCalledWith('mm-1', {
      status: 'failed',
      media_details: { error: { error: { code: 'BAD', message: 'bad' } } },
    });
    // Implementation calls span.end() in the 4XX branch AND again in the
    // outer catch when the rethrow propagates. Asserting actual behavior.
    expect(mockSpanEnd).toHaveBeenCalledTimes(2);
  });

  it('5XX (non-final attempt): does NOT write failed; throws', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 503, text: 'upstream down' }),
      );
    const repo = makeRepo();

    await expect(
      processHeygenGenerateJob(
        makeJob(videoData(), { attemptsMade: 0, attempts: 3 }),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('HeyGen 5XX: 503');

    expect(repo.update).not.toHaveBeenCalled();
    expect(mockSpanEnd).toHaveBeenCalledTimes(2);
  });

  it('5XX (final attempt): writes failed + error, then throws', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 502, text: 'gateway' }),
      );
    const repo = makeRepo();

    await expect(
      processHeygenGenerateJob(
        makeJob(videoData(), { attemptsMade: 2, attempts: 3 }),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('HeyGen 5XX: 502');

    expect(repo.update).toHaveBeenCalledWith('mm-1', {
      status: 'failed',
      media_details: { error: 'gateway' },
    });
  });

  it('5XX with no opts.attempts defaults to 1 — single attempt is the final attempt', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 500, text: 'oops' }),
      );
    const repo = makeRepo();

    await expect(
      processHeygenGenerateJob(
        // attemptsMade=0, attempts undefined → effective max=1, isLastAttempt=true
        {
          data: videoData(),
          attemptsMade: 0,
          opts: {},
        } as unknown as Job<HeygenGenerateJobData>,
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('HeyGen 5XX: 500');

    expect(repo.update).toHaveBeenCalled();
  });
});

describe('processHeygenGenerateJob — audio branch', () => {
  it('200 OK: streams audio to S3, updates row, enqueues whatsapp preload', async () => {
    const heygenJson = {
      data: {
        audio_url: 'https://heygen-cdn.example/clip.mp3',
        duration: 5.5,
        request_id: 'rq-1',
        word_timestamps: [{ word: 'hi', start: 0, end: 1 }],
      },
    };
    const audioBody = { fake: 'webstream' };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(fakeResponse({ ok: true, json: heygenJson }))
      .mockResolvedValueOnce(
        fakeResponse({
          ok: true,
          status: 200,
          body: audioBody,
          headers: { 'content-length': '4242' },
        }),
      );
    const repo = makeRepo();
    const bucket = makeBucket();

    await processHeygenGenerateJob(
      makeJob(audioData({ speed: 1.1, locale: 'hi-IN', language: 'hi' })),
      bucket as unknown as MediaBucketService,
      repo as unknown as Repository<MediaMetaDataEntity>,
    );

    // TTS request shape
    const [, ttsInit] = (global.fetch as jest.Mock).mock.calls[0];
    const sent = JSON.parse((ttsInit as RequestInit).body as string);
    expect(sent.text).toBe('hello');
    expect(sent.voice_id).toBe('env-voice'); // default
    expect(sent.speed).toBe('1.1'); // stringified
    expect(sent.locale).toBe('hi-IN');
    expect(sent.language).toBe('hi');

    expect(bucket.stream).toHaveBeenCalledWith(audioBody, 'audio/mpeg');
    expect(repo.update).toHaveBeenCalledWith('mm-2', {
      s3_key: 's3/key/x.mp3',
      media_details: {
        mime_type: 'audio/mpeg',
        duration: 5.5,
        byte_size: 4242,
        request_id: 'rq-1',
        word_timestamps: heygenJson.data.word_timestamps,
      },
      status: 'queued',
    });
    expect(mockQueueAdd).toHaveBeenCalledWith('preload-mm-2', {
      media_metadata_id: 'mm-2',
      s3_key: 's3/key/x.mp3',
      otel_carrier: { traceparent: 'tp' },
    });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('200 OK: byte_size is null when Content-Length header is absent', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({
          ok: true,
          json: {
            data: { audio_url: 'u', duration: 1, request_id: 'r' },
          },
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200, body: {} }));
    const repo = makeRepo();

    await processHeygenGenerateJob(
      makeJob(audioData()),
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

  it('200 OK: omits speed string when speed is undefined', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({
          ok: true,
          json: { data: { audio_url: 'u', duration: 1, request_id: 'r' } },
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ ok: true, body: {} }));
    const repo = makeRepo();

    await processHeygenGenerateJob(
      makeJob(audioData()),
      makeBucket() as unknown as MediaBucketService,
      repo as unknown as Repository<MediaMetaDataEntity>,
    );

    const sent = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(sent.speed).toBeUndefined();
  });

  it('throws when audio download (second fetch) is not OK', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({
          ok: true,
          json: { data: { audio_url: 'u', duration: 1, request_id: 'r' } },
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 404 }));
    const repo = makeRepo();

    await expect(
      processHeygenGenerateJob(
        makeJob(audioData()),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('Failed to download TTS audio: 404');

    expect(repo.update).not.toHaveBeenCalled();
    // outer catch ends span, body try ALSO ended span before returning → safe to assert ≥1
    expect(mockSpanEnd).toHaveBeenCalled();
  });

  it('4XX: writes failed + error, throws "HeyGen TTS 4XX:N"', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 401,
        json: { error: 'unauthorized' },
      }),
    );
    const repo = makeRepo();

    await expect(
      processHeygenGenerateJob(
        makeJob(audioData()),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('HeyGen TTS 4XX: 401');

    expect(repo.update).toHaveBeenCalledWith('mm-2', {
      status: 'failed',
      media_details: { error: { error: 'unauthorized' } },
    });
  });

  it('5XX (non-final attempt): does NOT write failed; throws', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(fakeResponse({ ok: false, status: 502, text: 'gw' }));
    const repo = makeRepo();

    await expect(
      processHeygenGenerateJob(
        makeJob(audioData(), { attemptsMade: 1, attempts: 5 }),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('HeyGen TTS 5XX: 502');

    expect(repo.update).not.toHaveBeenCalled();
  });

  it('5XX (final attempt): writes failed + error and throws', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: false, status: 500, text: 'down' }),
      );
    const repo = makeRepo();

    await expect(
      processHeygenGenerateJob(
        makeJob(audioData(), { attemptsMade: 4, attempts: 5 }),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('HeyGen TTS 5XX: 500');

    expect(repo.update).toHaveBeenCalledWith('mm-2', {
      status: 'failed',
      media_details: { error: 'down' },
    });
  });
});

describe('processHeygenGenerateJob — outer error handling', () => {
  it('ends span and rethrows when fetch itself rejects', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    const repo = makeRepo();

    await expect(
      processHeygenGenerateJob(
        makeJob(videoData()),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('network down');

    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('starts a child span with the carrier from job.data', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        fakeResponse({ ok: true, json: { data: { video_id: 'v' } } }),
      );
    await processHeygenGenerateJob(
      makeJob(videoData()),
      makeBucket() as unknown as MediaBucketService,
      makeRepo() as unknown as Repository<MediaMetaDataEntity>,
    );
    expect(mockStartChildSpan).toHaveBeenCalledWith(
      'heygen-generate-processor',
      { traceparent: 'parent' },
    );
  });
});
