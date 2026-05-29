process.env.LOG_PII_HMAC_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';

const mockQueueAdd = jest.fn();
const mockCreateQueue = jest.fn(() => ({ add: mockQueueAdd }));
jest.mock('../interfaces/redis/queues', () => ({
  createQueue: (...args: unknown[]) => mockCreateQueue(...args),
  QUEUE_NAMES: { WHATSAPP_PRELOAD: 'whatsapp-preload' },
}));

const mockSpanEnd = jest.fn();
const mockStartChildSpan = jest.fn(() => ({ end: mockSpanEnd }));
const mockInjectCarrier = jest.fn(() => ({ traceparent: 'tp' }));
jest.mock('../otel/otel', () => ({
  startChildSpan: (...args: unknown[]) => mockStartChildSpan(...args),
  injectCarrier: (...args: unknown[]) => mockInjectCarrier(...args),
}));

import type { Job } from 'bullmq';
import type { Repository } from 'typeorm';
import type { MediaMetaDataEntity } from './media-meta-data.entity';
import type { CacheService } from '../interfaces/redis/cache';
import type { MediaBucketService } from '../interfaces/media-bucket/outbound/outbound.service';
import type { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';
import type { WhatsappPreloadJobDto } from './media-meta-data.dto';
import { processWhatsappPreloadJob } from './whatsapp-preload.processor';

function makeJob(
  data: Partial<WhatsappPreloadJobDto> & { media_metadata_id: string; s3_key: string },
  opts: { attemptsMade?: number; attempts?: number } = {},
): Job<WhatsappPreloadJobDto> {
  return {
    id: 'job-1',
    data: { otel_carrier: { traceparent: 'parent' }, ...data } as WhatsappPreloadJobDto,
    attemptsMade: opts.attemptsMade ?? 0,
    opts: { attempts: opts.attempts ?? 3 },
  } as unknown as Job<WhatsappPreloadJobDto>;
}

function makeBucket(getBuffer: jest.Mock): MediaBucketService {
  return { getBuffer } as unknown as MediaBucketService;
}
function makeWabot(uploadMedia: jest.Mock): WabotOutboundService {
  return { uploadMedia } as unknown as WabotOutboundService;
}
function makeCache(del: jest.Mock): CacheService {
  return { del } as unknown as CacheService;
}
function makeRepo(opts: {
  findOneBy?: jest.Mock;
  update?: jest.Mock;
}): Repository<MediaMetaDataEntity> {
  return {
    findOneBy: opts.findOneBy ?? jest.fn(),
    update: opts.update ?? jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as Repository<MediaMetaDataEntity>;
}

beforeEach(() => {
  mockQueueAdd.mockReset().mockResolvedValue(undefined);
  mockSpanEnd.mockReset();
  mockStartChildSpan.mockClear();
  mockInjectCarrier.mockClear();
});

describe('processWhatsappPreloadJob — early skips', () => {
  it('skips when the entity row is missing', async () => {
    const repo = makeRepo({ findOneBy: jest.fn().mockResolvedValue(null) });
    const bucket = makeBucket(jest.fn());

    await processWhatsappPreloadJob(
      makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1' }),
      bucket,
      makeWabot(jest.fn()),
      makeCache(jest.fn()),
      repo,
    );

    expect(bucket.getBuffer).not.toHaveBeenCalled();
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('skips when the entity is rolled back', async () => {
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'mm-1',
        rolled_back: true,
        media_type: 'audio',
        status: 'ready',
      }),
    });
    const bucket = makeBucket(jest.fn());

    await processWhatsappPreloadJob(
      makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1' }),
      bucket,
      makeWabot(jest.fn()),
      makeCache(jest.fn()),
      repo,
    );

    expect(bucket.getBuffer).not.toHaveBeenCalled();
  });

  it('skips when the entity status is failed', async () => {
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'mm-1',
        rolled_back: false,
        status: 'failed',
        media_type: 'audio',
      }),
    });
    const bucket = makeBucket(jest.fn());

    await processWhatsappPreloadJob(
      makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1' }),
      bucket,
      makeWabot(jest.fn()),
      makeCache(jest.fn()),
      repo,
    );

    expect(bucket.getBuffer).not.toHaveBeenCalled();
  });
});

describe('processWhatsappPreloadJob — S3 failure', () => {
  it('rethrows on getBuffer failure (non-final attempt logs warn)', async () => {
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'mm-1',
        rolled_back: false,
        status: 'queued',
        media_type: 'audio',
      }),
    });
    const bucket = makeBucket(jest.fn().mockRejectedValue(new Error('s3 down')));

    await expect(
      processWhatsappPreloadJob(
        makeJob(
          { media_metadata_id: 'mm-1', s3_key: 's3-1' },
          { attemptsMade: 0, attempts: 3 },
        ),
        bucket,
        makeWabot(jest.fn()),
        makeCache(jest.fn()),
        repo,
      ),
    ).rejects.toThrow('s3 down');
  });

  it('rethrows on getBuffer failure (final attempt logs error)', async () => {
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'mm-1',
        rolled_back: false,
        status: 'queued',
        media_type: 'audio',
      }),
    });
    const bucket = makeBucket(jest.fn().mockRejectedValue(new Error('s3 down')));

    await expect(
      processWhatsappPreloadJob(
        makeJob(
          { media_metadata_id: 'mm-1', s3_key: 's3-1' },
          { attemptsMade: 2, attempts: 3 },
        ),
        bucket,
        makeWabot(jest.fn()),
        makeCache(jest.fn()),
        repo,
      ),
    ).rejects.toThrow('s3 down');
  });
});

describe('processWhatsappPreloadJob — uploadMedia failure', () => {
  function setup(uploadError: Error) {
    const entity = {
      id: 'mm-1',
      rolled_back: false,
      status: 'queued',
      media_type: 'audio',
      state_transition_id: null,
    };
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue(entity),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    });
    const bucket = makeBucket(
      jest.fn().mockResolvedValue({
        buffer: Buffer.from('audio'),
        content_type: 'audio/mpeg',
      }),
    );
    const wabot = makeWabot(jest.fn().mockRejectedValue(uploadError));
    return { repo, bucket, wabot };
  }

  it('on 4XX error: marks entity failed then rethrows', async () => {
    const { repo, bucket, wabot } = setup(new Error('uploadMedia failed with 422'));

    await expect(
      processWhatsappPreloadJob(
        makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1' }),
        bucket,
        wabot,
        makeCache(jest.fn()),
        repo,
      ),
    ).rejects.toThrow('422');

    expect(repo.update).toHaveBeenCalledWith('mm-1', { status: 'failed' });
  });

  it('on 5XX error: does NOT mark failed (transient — let BullMQ retry)', async () => {
    const { repo, bucket, wabot } = setup(new Error('uploadMedia failed with 503'));

    await expect(
      processWhatsappPreloadJob(
        makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1' }),
        bucket,
        wabot,
        makeCache(jest.fn()),
        repo,
      ),
    ).rejects.toThrow('503');

    expect(repo.update).not.toHaveBeenCalled();
  });

  it('on error with no parseable status: treats as 5XX (no failed write)', async () => {
    const { repo, bucket, wabot } = setup(new Error('network timeout no status code'));

    await expect(
      processWhatsappPreloadJob(
        makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1' }),
        bucket,
        wabot,
        makeCache(jest.fn()),
        repo,
      ),
    ).rejects.toThrow('network timeout');
    expect(repo.update).not.toHaveBeenCalled();
  });
});

describe('processWhatsappPreloadJob — happy path', () => {
  function setupHappy(opts: {
    state_transition_id?: string | null;
    reload?: boolean;
  } = {}) {
    const entity = {
      id: 'mm-1',
      rolled_back: false,
      status: 'queued',
      media_type: 'audio',
      state_transition_id: opts.state_transition_id ?? null,
    };
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue(entity),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    });
    const bucket = makeBucket(
      jest.fn().mockResolvedValue({
        buffer: Buffer.from('audio'),
        content_type: 'audio/mpeg',
      }),
    );
    const wabot = makeWabot(
      jest.fn().mockResolvedValue({ wa_media_url: 'https://wabot/m/1' }),
    );
    const cache = makeCache(jest.fn().mockResolvedValue(undefined));
    return { repo, bucket, wabot, cache };
  }

  it('first preload (reload=false): updates wa_media_url + status="ready"', async () => {
    const { repo, bucket, wabot, cache } = setupHappy({
      state_transition_id: 'क-letter-word-correct-last',
    });

    await processWhatsappPreloadJob(
      makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1', reload: false }),
      bucket,
      wabot,
      cache,
      repo,
    );

    expect(repo.update).toHaveBeenCalledWith('mm-1', {
      wa_media_url: 'https://wabot/m/1',
      status: 'ready',
    });
    // Cache invalidated for the stid.
    expect(cache.del).toHaveBeenCalledWith(
      'media:stid:क-letter-word-correct-last',
    );
    // Reload job enqueued with 20d delay.
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'reload-mm-1',
      expect.objectContaining({ media_metadata_id: 'mm-1', reload: true }),
      { delay: 20 * 24 * 60 * 60 * 1000 },
    );
  });

  it('reload=true: updates wa_media_url only (no status change)', async () => {
    const { repo, bucket, wabot, cache } = setupHappy();

    await processWhatsappPreloadJob(
      makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1', reload: true }),
      bucket,
      wabot,
      cache,
      repo,
    );

    expect(repo.update).toHaveBeenCalledWith('mm-1', {
      wa_media_url: 'https://wabot/m/1',
    });
  });

  it('skips cache invalidation when entity has no state_transition_id', async () => {
    const { repo, bucket, wabot, cache } = setupHappy({
      state_transition_id: null,
    });

    await processWhatsappPreloadJob(
      makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1' }),
      bucket,
      wabot,
      cache,
      repo,
    );

    expect(cache.del).not.toHaveBeenCalled();
  });

  it('continues silently when reload-enqueue deadline (10s) is exceeded — does not throw', async () => {
    const { repo, bucket, wabot, cache } = setupHappy();

    let now = 0;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockQueueAdd.mockImplementation(() => {
      now += 11_000; // synthetic clock advance trips the 10s budget
      return Promise.reject(new Error('redis blip'));
    });

    await processWhatsappPreloadJob(
      makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1' }),
      bucket,
      wabot,
      cache,
      repo,
    );

    // The function does not throw — it logs and continues, then ends span.
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
    dateSpy.mockRestore();
  });
});

// ─── mutation hardening ────────────────────────────────────────────────────

import { Logger as NestLogger } from '@nestjs/common';

function spyWarnError() {
  return {
    warn: jest.spyOn(NestLogger.prototype, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(NestLogger.prototype, 'error').mockImplementation(() => undefined),
  };
}

describe('processWhatsappPreloadJob — span name + log messages', () => {
  it('starts a child span named "whatsapp-preload-processor" with the job otel_carrier', async () => {
    const repo = makeRepo({ findOneBy: jest.fn().mockResolvedValue(null) });
    const job = makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1' });
    await processWhatsappPreloadJob(
      job,
      makeBucket(jest.fn()),
      makeWabot(jest.fn()),
      makeCache(jest.fn()),
      repo,
    );
    expect(mockStartChildSpan).toHaveBeenCalledWith(
      'whatsapp-preload-processor',
      job.data.otel_carrier,
    );
  });

  it('warns "Entity <id> not found — skipping" when the row is missing', async () => {
    const { warn } = spyWarnError();
    const repo = makeRepo({ findOneBy: jest.fn().mockResolvedValue(null) });
    await processWhatsappPreloadJob(
      makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1' }),
      makeBucket(jest.fn()),
      makeWabot(jest.fn()),
      makeCache(jest.fn()),
      repo,
    );
    expect(warn).toHaveBeenCalledWith('Entity mm-1 not found — skipping');
    warn.mockRestore();
  });

  it('warns "Entity <id> rolled back — skipping" when entity.rolled_back is true', async () => {
    const { warn } = spyWarnError();
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'mm-1',
        rolled_back: true,
        media_type: 'audio',
        status: 'ready',
      }),
    });
    await processWhatsappPreloadJob(
      makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1' }),
      makeBucket(jest.fn()),
      makeWabot(jest.fn()),
      makeCache(jest.fn()),
      repo,
    );
    expect(warn).toHaveBeenCalledWith('Entity mm-1 rolled back — skipping');
    warn.mockRestore();
  });

  it('warns "Entity <id> has failed status — skipping" when entity.status is "failed"', async () => {
    const { warn } = spyWarnError();
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'mm-1',
        rolled_back: false,
        media_type: 'audio',
        status: 'failed',
      }),
    });
    await processWhatsappPreloadJob(
      makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-1' }),
      makeBucket(jest.fn()),
      makeWabot(jest.fn()),
      makeCache(jest.fn()),
      repo,
    );
    expect(warn).toHaveBeenCalledWith(
      'Entity mm-1 has failed status — skipping',
    );
    warn.mockRestore();
  });
});

describe('processWhatsappPreloadJob — boundaries', () => {
  const baseEntity = {
    id: 'mm-1',
    rolled_back: false,
    media_type: 'audio' as const,
    status: 'created' as const,
    state_transition_id: 'stid-1',
  };

  it('S3 getBuffer final-attempt boundary: attemptsMade + 1 === attempts logs ERROR (not warn)', async () => {
    const { warn, error } = spyWarnError();
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({ ...baseEntity }),
    });
    const bucket = makeBucket(
      jest.fn().mockRejectedValue(new Error('s3 boom')),
    );
    // attemptsMade=2, attempts=3 → 2+1 === 3 is the FINAL attempt.
    const job = makeJob(
      { media_metadata_id: 'mm-1', s3_key: 's3-key' },
      { attemptsMade: 2, attempts: 3 },
    );
    await expect(
      processWhatsappPreloadJob(
        job,
        bucket,
        makeWabot(jest.fn()),
        makeCache(jest.fn()),
        repo,
      ),
    ).rejects.toThrow('s3 boom');
    expect(error).toHaveBeenCalledWith(
      'S3 getBuffer failed for s3-key (final attempt): s3 boom',
    );
    // Must NOT also warn the non-final message
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/\(attempt \d+\)/),
    );
    warn.mockRestore();
    error.mockRestore();
  });

  it('S3 getBuffer non-final attempt logs WARN with the 1-based attempt number', async () => {
    const { warn } = spyWarnError();
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({ ...baseEntity }),
    });
    const bucket = makeBucket(
      jest.fn().mockRejectedValue(new Error('s3 boom')),
    );
    // attemptsMade=0, attempts=3 → 1-based attempt 1, NOT final.
    const job = makeJob(
      { media_metadata_id: 'mm-1', s3_key: 's3-key' },
      { attemptsMade: 0, attempts: 3 },
    );
    await expect(
      processWhatsappPreloadJob(
        job,
        bucket,
        makeWabot(jest.fn()),
        makeCache(jest.fn()),
        repo,
      ),
    ).rejects.toThrow('s3 boom');
    expect(warn).toHaveBeenCalledWith(
      'S3 getBuffer failed for s3-key (attempt 1): s3 boom',
    );
    warn.mockRestore();
  });

  it.each<[string, number]>([
    ['400 Bad Request', 400],
    ['404 Not Found', 404],
    ['499 unusual', 499],
  ])(
    'uploadMedia error containing "%s" is treated as 4XX (marks failed)',
    async (msg, _status) => {
      const { error } = spyWarnError();
      const repo = makeRepo({
        findOneBy: jest.fn().mockResolvedValue({ ...baseEntity }),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      const bucket = makeBucket(
        jest
          .fn()
          .mockResolvedValue({ buffer: Buffer.from('a'), content_type: 'audio/mp3' }),
      );
      const wabot = makeWabot(jest.fn().mockRejectedValue(new Error(msg)));
      await expect(
        processWhatsappPreloadJob(
          makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-key' }),
          bucket,
          wabot,
          makeCache(jest.fn()),
          repo,
        ),
      ).rejects.toThrow();
      expect(error).toHaveBeenCalledWith('uploadMedia 4XX for mm-1');
      expect(repo.update).toHaveBeenCalledWith('mm-1', { status: 'failed' });
      error.mockRestore();
    },
  );

  it('uploadMedia 5XX error (status === 500): does NOT mark failed (kills <500 → <=)', async () => {
    const { warn, error } = spyWarnError();
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({ ...baseEntity }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    });
    const bucket = makeBucket(
      jest
        .fn()
        .mockResolvedValue({ buffer: Buffer.from('a'), content_type: 'audio/mp3' }),
    );
    const wabot = makeWabot(jest.fn().mockRejectedValue(new Error('500 boom')));
    await expect(
      processWhatsappPreloadJob(
        makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-key' }),
        bucket,
        wabot,
        makeCache(jest.fn()),
        repo,
      ),
    ).rejects.toThrow('500 boom');
    expect(warn).toHaveBeenCalledWith('uploadMedia 5XX for mm-1');
    // status 500 is NOT 4XX → no failed update
    expect(repo.update).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('uploadMedia 399 (just below 400) is NOT treated as 4XX (kills >=400 → > 400 boundary)', async () => {
    const { warn } = spyWarnError();
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({ ...baseEntity }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    });
    const bucket = makeBucket(
      jest
        .fn()
        .mockResolvedValue({ buffer: Buffer.from('a'), content_type: 'audio/mp3' }),
    );
    const wabot = makeWabot(jest.fn().mockRejectedValue(new Error('399 weird')));
    await expect(
      processWhatsappPreloadJob(
        makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-key' }),
        bucket,
        wabot,
        makeCache(jest.fn()),
        repo,
      ),
    ).rejects.toThrow('399 weird');
    expect(warn).toHaveBeenCalledWith('uploadMedia 5XX for mm-1');
    expect(repo.update).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('processWhatsappPreloadJob — reload enqueue payload', () => {
  it('reload-enqueue uses the right name, payload (reload=true), and 20-day delay', async () => {
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'mm-1',
        rolled_back: false,
        media_type: 'audio',
        status: 'created',
        state_transition_id: 'stid-1',
      }),
    });
    const bucket = makeBucket(
      jest
        .fn()
        .mockResolvedValue({ buffer: Buffer.from('a'), content_type: 'audio/mp3' }),
    );
    const wabot = makeWabot(
      jest.fn().mockResolvedValue({ wa_media_url: 'https://wa/m1' }),
    );
    await processWhatsappPreloadJob(
      makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-key', reload: false }),
      bucket,
      wabot,
      makeCache(jest.fn().mockResolvedValue(undefined)),
      repo,
    );
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd.mock.calls[0][0]).toBe('reload-mm-1');
    expect(mockQueueAdd.mock.calls[0][1]).toMatchObject({
      media_metadata_id: 'mm-1',
      s3_key: 's3-key',
      reload: true,
    });
    expect(mockQueueAdd.mock.calls[0][2]).toEqual({
      delay: 20 * 24 * 60 * 60 * 1000,
    });
  });
});

describe('processWhatsappPreloadJob — cache invalidation key', () => {
  it('invalidates the media:stid:<stid> cache key on success', async () => {
    const repo = makeRepo({
      findOneBy: jest.fn().mockResolvedValue({
        id: 'mm-1',
        rolled_back: false,
        media_type: 'audio',
        status: 'created',
        state_transition_id: 'कमल-start-word-initial',
      }),
    });
    const bucket = makeBucket(
      jest
        .fn()
        .mockResolvedValue({ buffer: Buffer.from('a'), content_type: 'audio/mp3' }),
    );
    const wabot = makeWabot(
      jest.fn().mockResolvedValue({ wa_media_url: 'https://wa/m1' }),
    );
    const cacheDel = jest.fn().mockResolvedValue(undefined);
    await processWhatsappPreloadJob(
      makeJob({ media_metadata_id: 'mm-1', s3_key: 's3-key', reload: false }),
      bucket,
      wabot,
      makeCache(cacheDel),
      repo,
    );
    expect(cacheDel).toHaveBeenCalledWith('media:stid:कमल-start-word-initial');
  });
});
