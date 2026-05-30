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

import type { Job } from 'bullmq';
import type { Repository } from 'typeorm';
import type { MediaBucketService } from '../../media-bucket/outbound/outbound.service';
import type { MediaMetaDataEntity } from '../../../media-meta-data/media-meta-data.entity';
import { HeygenInboundJobDto } from './inbound.dto';
import { processHeygenInboundJob } from './inbound.processor';

type RepoMock = { findOneBy: jest.Mock; update: jest.Mock };
type BucketMock = { stream: jest.Mock };

function makeRepo(): RepoMock {
  return {
    findOneBy: jest.fn().mockResolvedValue({ id: 'cb1' }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}
function makeBucket(): BucketMock {
  return { stream: jest.fn().mockResolvedValue('s3/key.mp4') };
}

function successJob(
  event_data: Partial<{ url: string; callback_id: string }> = {
    url: 'https://cdn/v.mp4',
    callback_id: 'cb1',
  },
  opts: { attemptsMade?: number; attempts?: number } = {},
): Job<HeygenInboundJobDto> {
  return {
    data: {
      event_type: 'avatar_video.success',
      event_data: event_data as Record<string, unknown>,
      otel_carrier: { traceparent: 'parent' } as never,
    },
    attemptsMade: opts.attemptsMade ?? 0,
    opts: { attempts: opts.attempts ?? 3 },
  } as unknown as Job<HeygenInboundJobDto>;
}

function failJob(
  event_data: Partial<{
    video_id: string;
    msg: string;
    callback_id: string;
  }> = {
    video_id: 'v1',
    msg: 'oops',
    callback_id: 'cb1',
  },
): Job<HeygenInboundJobDto> {
  return {
    data: {
      event_type: 'avatar_video.fail',
      event_data: event_data as Record<string, unknown>,
      otel_carrier: { traceparent: 'parent' } as never,
    },
    attemptsMade: 0,
    opts: { attempts: 1 },
  } as unknown as Job<HeygenInboundJobDto>;
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

describe('processHeygenInboundJob — avatar_video.success', () => {
  it('downloads, streams to S3, updates row, enqueues whatsapp preload', async () => {
    const audioBody = { kind: 'webstream' };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: audioBody });
    const repo = makeRepo();
    const bucket = makeBucket();

    await processHeygenInboundJob(
      successJob(),
      bucket as unknown as MediaBucketService,
      repo as unknown as Repository<MediaMetaDataEntity>,
    );

    expect(repo.findOneBy).toHaveBeenCalledWith({ id: 'cb1' });
    expect(bucket.stream).toHaveBeenCalledWith(audioBody, 'video/mp4');
    expect(repo.update).toHaveBeenCalledWith('cb1', {
      s3_key: 's3/key.mp4',
      media_details: {
        video_url: 'https://cdn/v.mp4',
        mime_type: 'video/mp4',
      },
      status: 'queued',
    });
    expect(mockQueueAdd).toHaveBeenCalledWith('preload-cb1', {
      media_metadata_id: 'cb1',
      s3_key: 's3/key.mp4',
      otel_carrier: { traceparent: 'tp' },
    });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('throws when callback_id is missing entirely', async () => {
    const repo = makeRepo();
    await expect(
      processHeygenInboundJob(
        successJob({ url: 'u' }),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('Missing callback_id');
    expect(repo.findOneBy).not.toHaveBeenCalled();
  });

  it('throws when callback_id is empty string', async () => {
    const repo = makeRepo();
    await expect(
      processHeygenInboundJob(
        successJob({ url: 'u', callback_id: '' }),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('Missing callback_id');
  });

  it('throws when media_metadata row is not found', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    await expect(
      processHeygenInboundJob(
        successJob(),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('Entity not found');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('on download failure (non-final attempt): warns, does NOT mark failed, throws', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const repo = makeRepo();

    await expect(
      processHeygenInboundJob(
        successJob(undefined, { attemptsMade: 0, attempts: 3 }),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('Video download failed');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('on download failure (final attempt): marks failed then throws', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const repo = makeRepo();

    await expect(
      processHeygenInboundJob(
        successJob(undefined, { attemptsMade: 2, attempts: 3 }),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('Video download failed');
    expect(repo.update).toHaveBeenCalledWith('cb1', { status: 'failed' });
  });

  it('on S3 upload failure (non-final attempt): warns, does NOT mark failed, rethrows', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body: {} });
    const repo = makeRepo();
    const bucket = makeBucket();
    bucket.stream.mockRejectedValue(new Error('s3 down'));

    await expect(
      processHeygenInboundJob(
        successJob(undefined, { attemptsMade: 0, attempts: 3 }),
        bucket as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('s3 down');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('on S3 upload failure (final attempt): marks failed then rethrows', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body: {} });
    const repo = makeRepo();
    const bucket = makeBucket();
    bucket.stream.mockRejectedValue(new Error('s3 down'));

    await expect(
      processHeygenInboundJob(
        successJob(undefined, { attemptsMade: 2, attempts: 3 }),
        bucket as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('s3 down');
    expect(repo.update).toHaveBeenCalledWith('cb1', { status: 'failed' });
  });

  it('defaults opts.attempts to 1 when undefined (single attempt is final)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const repo = makeRepo();

    await expect(
      processHeygenInboundJob(
        {
          data: {
            event_type: 'avatar_video.success',
            event_data: { url: 'u', callback_id: 'cb1' },
            otel_carrier: { traceparent: 'parent' } as never,
          },
          attemptsMade: 0,
          opts: {},
        } as unknown as Job<HeygenInboundJobDto>,
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('Video download failed');
    expect(repo.update).toHaveBeenCalledWith('cb1', { status: 'failed' });
  });
});

describe('processHeygenInboundJob — avatar_video.fail', () => {
  it('marks entity as failed with error_msg and ends span', async () => {
    const repo = makeRepo();

    await processHeygenInboundJob(
      failJob(),
      makeBucket() as unknown as MediaBucketService,
      repo as unknown as Repository<MediaMetaDataEntity>,
    );

    expect(repo.update).toHaveBeenCalledWith('cb1', {
      status: 'failed',
      media_details: { error_msg: 'oops' },
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('throws when callback_id is missing', async () => {
    const repo = makeRepo();
    await expect(
      processHeygenInboundJob(
        failJob({ video_id: 'v', msg: 'm' }),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('Missing callback_id');
    expect(repo.findOneBy).not.toHaveBeenCalled();
  });

  it('throws when callback_id is empty', async () => {
    const repo = makeRepo();
    await expect(
      processHeygenInboundJob(
        failJob({ video_id: 'v', msg: 'm', callback_id: '' }),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('Missing callback_id');
  });

  it('throws when entity is not found', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    await expect(
      processHeygenInboundJob(
        failJob(),
        makeBucket() as unknown as MediaBucketService,
        repo as unknown as Repository<MediaMetaDataEntity>,
      ),
    ).rejects.toThrow('Entity not found');
    expect(repo.update).not.toHaveBeenCalled();
  });
});

describe('processHeygenInboundJob — unhandled event_type', () => {
  it('no-ops cleanly when event_type matches neither branch', async () => {
    const repo = makeRepo();
    const bucket = makeBucket();

    await processHeygenInboundJob(
      {
        data: {
          event_type:
            'avatar_video.queued' as unknown as 'avatar_video.success',
          event_data: {},
          otel_carrier: { traceparent: 'parent' } as never,
        },
        attemptsMade: 0,
        opts: { attempts: 1 },
      } as unknown as Job<HeygenInboundJobDto>,
      bucket as unknown as MediaBucketService,
      repo as unknown as Repository<MediaMetaDataEntity>,
    );

    expect(repo.findOneBy).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    // span is never explicitly ended on the no-op fall-through — neither
    // branch ran and there was no error to trigger the outer catch.
    expect(mockSpanEnd).not.toHaveBeenCalled();
  });
});
