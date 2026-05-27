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
