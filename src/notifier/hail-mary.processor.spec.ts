// Set HMAC key BEFORE any import that touches pii.ts — it caches on first call.
process.env.LOG_PII_HMAC_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';

const mockQueueAdd = jest.fn();
const mockQueueRemove = jest.fn();
const mockQueueGetJob = jest.fn();
const mockCreateQueue = jest.fn(() => ({
  add: mockQueueAdd,
  remove: mockQueueRemove,
  getJob: mockQueueGetJob,
}));
jest.mock('../interfaces/redis/queues', () => ({
  createQueue: (...args: unknown[]) => mockCreateQueue(...args),
  QUEUE_NAMES: { HAIL_MARY: 'hail-mary' },
}));

const mockSpanEnd = jest.fn();
const mockSpanSetAttribute = jest.fn();
const mockSpanSetStatus = jest.fn();
const mockSpanRecordException = jest.fn();
const mockInjectCarrier = jest.fn(() => ({ traceparent: 'tp' }));
jest.mock('../otel/otel', () => ({
  tracer: {
    startActiveSpan: jest.fn(async (_name: string, cb: any) =>
      cb({
        setAttribute: mockSpanSetAttribute,
        setStatus: mockSpanSetStatus,
        recordException: mockSpanRecordException,
        end: mockSpanEnd,
      }),
    ),
  },
  injectCarrier: (...args: unknown[]) => mockInjectCarrier(...args),
}));

import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import type { UserService } from '../users/user.service';
import type { MediaMetaDataService } from '../media-meta-data/media-meta-data.service';
import type { LiteracyLessonService } from '../literacy/literacy-lesson/literacy-lesson.service';
import type { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';
import {
  rearmHailMary,
  processHailMaryJob,
  HAIL_MARY_DELAY_MS,
  HailMaryJobData,
} from './hail-mary.processor';

function makeJob(data: Partial<HailMaryJobData> = {}): Job<HailMaryJobData> {
  return {
    id: 'job-1',
    data: {
      user_id: 'u1',
      user_external_id: '919999990001',
      user_message_id: 'mm-9',
      otel_carrier: { traceparent: 'parent' } as never,
      ...data,
    },
  } as unknown as Job<HailMaryJobData>;
}

function makeQuery(...rounds: unknown[][]): jest.Mock {
  const q = jest.fn();
  for (const r of rounds) q.mockResolvedValueOnce(r);
  return q;
}

function makeUserService(find: jest.Mock): UserService {
  return { find } as unknown as UserService;
}
function makeMedia(findMediaByStateTransitionId: jest.Mock): MediaMetaDataService {
  return {
    findMediaByStateTransitionId,
  } as unknown as MediaMetaDataService;
}
function makeLesson(processAnswer: jest.Mock): LiteracyLessonService {
  return { processAnswer } as unknown as LiteracyLessonService;
}
function makeWabot(sendMessage: jest.Mock): WabotOutboundService {
  return { sendMessage } as unknown as WabotOutboundService;
}

beforeEach(() => {
  mockQueueAdd.mockReset().mockResolvedValue(undefined);
  mockQueueRemove.mockReset().mockResolvedValue(undefined);
  mockQueueGetJob.mockReset();
  mockSpanEnd.mockReset();
  mockSpanSetAttribute.mockReset();
  mockSpanSetStatus.mockReset();
  mockSpanRecordException.mockReset();
  mockInjectCarrier.mockClear();
  mockCreateQueue.mockClear();
});

describe('rearmHailMary', () => {
  it('removes the prior job and re-adds with stable jobId + 23h55 delay', async () => {
    await rearmHailMary({
      user_id: 'u1',
      user_external_id: '91999',
      user_message_id: 'mm-1',
      otel_carrier: { traceparent: 'tp' } as never,
    });

    expect(mockQueueRemove).toHaveBeenCalledWith('hail-mary:u1');
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'hail-mary',
      expect.objectContaining({ user_id: 'u1', user_message_id: 'mm-1' }),
      { jobId: 'hail-mary:u1', delay: HAIL_MARY_DELAY_MS },
    );
  });
});

describe('processHailMaryJob — early exits', () => {
  it('skips when the user has zero whatsapp messages', async () => {
    const ds = { query: makeQuery([]) } as unknown as DataSource;
    await processHailMaryJob(
      makeJob(),
      ds,
      makeUserService(jest.fn()),
      makeMedia(jest.fn()),
      makeLesson(jest.fn()),
      makeWabot(jest.fn()),
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'hail_mary.skip_reason',
      'no-latest-message',
    );
    expect(mockSpanEnd).toHaveBeenCalled();
  });

  it('rearms against latest message when chain is stale and no delayed job exists', async () => {
    const ds = {
      query: makeQuery([{ id: 'mm-newer', created_at: new Date() }]),
    } as unknown as DataSource;
    mockQueueGetJob.mockResolvedValue(null); // no existing job

    await processHailMaryJob(
      makeJob({ user_message_id: 'mm-old' }),
      ds,
      makeUserService(jest.fn()),
      makeMedia(jest.fn()),
      makeLesson(jest.fn()),
      makeWabot(jest.fn()),
    );

    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'hail_mary.skip_reason',
      'stale',
    );
    // rearm: remove + add
    expect(mockQueueRemove).toHaveBeenCalledWith('hail-mary:u1');
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it('rearms when existing delayed job is in active state (self-exclusion)', async () => {
    const ds = {
      query: makeQuery([{ id: 'mm-newer', created_at: new Date() }]),
    } as unknown as DataSource;
    mockQueueGetJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('active'),
    });

    await processHailMaryJob(
      makeJob({ user_message_id: 'mm-old' }),
      ds,
      makeUserService(jest.fn()),
      makeMedia(jest.fn()),
      makeLesson(jest.fn()),
      makeWabot(jest.fn()),
    );

    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it('does NOT rearm when a delayed job already exists in a non-active state', async () => {
    const ds = {
      query: makeQuery([{ id: 'mm-newer', created_at: new Date() }]),
    } as unknown as DataSource;
    mockQueueGetJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('delayed'),
    });

    await processHailMaryJob(
      makeJob({ user_message_id: 'mm-old' }),
      ds,
      makeUserService(jest.fn()),
      makeMedia(jest.fn()),
      makeLesson(jest.fn()),
      makeWabot(jest.fn()),
    );

    // remove/add only called for the queue introspection above, not for rearm.
    // rearm path would invoke remove THEN add; here neither happened during rearm.
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockQueueRemove).not.toHaveBeenCalled();
  });

  it('tolerates getState() rejecting (treated as "unknown") and does NOT rearm', async () => {
    const ds = {
      query: makeQuery([{ id: 'mm-newer', created_at: new Date() }]),
    } as unknown as DataSource;
    mockQueueGetJob.mockResolvedValue({
      getState: jest.fn().mockRejectedValue(new Error('redis blip')),
    });

    await processHailMaryJob(
      makeJob({ user_message_id: 'mm-old' }),
      ds,
      makeUserService(jest.fn()),
      makeMedia(jest.fn()),
      makeLesson(jest.fn()),
      makeWabot(jest.fn()),
    );

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('skips when the latest message is older than 24h', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const ds = {
      query: makeQuery([{ id: 'mm-9', created_at: old }]),
    } as unknown as DataSource;

    await processHailMaryJob(
      makeJob({ user_message_id: 'mm-9' }),
      ds,
      makeUserService(jest.fn()),
      makeMedia(jest.fn()),
      makeLesson(jest.fn()),
      makeWabot(jest.fn()),
    );

    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'hail_mary.skip_reason',
      'window-expired',
    );
  });

  it('skips when user is not found', async () => {
    const ds = {
      query: makeQuery([{ id: 'mm-9', created_at: new Date() }]),
    } as unknown as DataSource;

    await processHailMaryJob(
      makeJob({ user_message_id: 'mm-9' }),
      ds,
      makeUserService(jest.fn().mockResolvedValue(null)),
      makeMedia(jest.fn()),
      makeLesson(jest.fn()),
      makeWabot(jest.fn()),
    );

    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'hail_mary.skip_reason',
      'user-not-found',
    );
  });
});

describe('processHailMaryJob — happy + media tolerance', () => {
  it('sends the hail-mary intro video plus lesson media when present', async () => {
    const ds = {
      query: makeQuery([{ id: 'mm-9', created_at: new Date() }]),
    } as unknown as DataSource;
    const wabot = makeWabot(jest.fn().mockResolvedValue({ status: 200 }));
    const media = makeMedia(
      jest
        .fn()
        // hail-mary stid lookup → video
        .mockResolvedValueOnce({
          video: {
            wa_media_url: 'https://wa/v.mp4',
            media_details: { mime_type: 'video/mp4' },
          },
        })
        // lesson stid lookup → text payload
        .mockResolvedValueOnce({
          text: { text: 'good job' },
        }),
    );
    const lesson = makeLesson(
      jest.fn().mockResolvedValue({ stateTransitionIds: ['lesson-1'] }),
    );

    await processHailMaryJob(
      makeJob({ user_message_id: 'mm-9' }),
      ds,
      makeUserService(jest.fn().mockResolvedValue({ id: 'u1' })),
      media,
      lesson,
      wabot,
    );

    expect(wabot.sendMessage).toHaveBeenCalledTimes(1);
    const [args] = (wabot.sendMessage as jest.Mock).mock.calls[0];
    expect(args.media).toEqual([
      { type: 'video', url: 'https://wa/v.mp4', mime_type: 'video/mp4' },
      { type: 'text', body: 'good job' },
    ]);
  });

  it('tolerates intro-media fetch failure and lesson failure independently — still sends if any media survives', async () => {
    const ds = {
      query: makeQuery([{ id: 'mm-9', created_at: new Date() }]),
    } as unknown as DataSource;
    const wabot = makeWabot(jest.fn().mockResolvedValue({ status: 200 }));
    // intro-media call rejects, processAnswer rejects entirely
    const findMedia = jest
      .fn()
      .mockRejectedValueOnce(new Error('intro fetch failed'));
    const lesson = makeLesson(
      jest.fn().mockRejectedValue(new Error('lesson failed')),
    );

    await processHailMaryJob(
      makeJob({ user_message_id: 'mm-9' }),
      ds,
      makeUserService(jest.fn().mockResolvedValue({ id: 'u1' })),
      makeMedia(findMedia),
      lesson,
      wabot,
    );

    // No media at all → skip; no send
    expect(wabot.sendMessage).not.toHaveBeenCalled();
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'hail_mary.skip_reason',
      'no-media',
    );
  });

  it('tolerates a single lesson stid lookup failing — keeps other media', async () => {
    const ds = {
      query: makeQuery([{ id: 'mm-9', created_at: new Date() }]),
    } as unknown as DataSource;
    const wabot = makeWabot(jest.fn().mockResolvedValue({ status: 200 }));
    const media = makeMedia(
      jest
        .fn()
        .mockResolvedValueOnce({
          video: { wa_media_url: 'https://wa/v.mp4', media_details: null },
        })
        .mockRejectedValueOnce(new Error('stid lookup failed')),
    );
    const lesson = makeLesson(
      jest.fn().mockResolvedValue({ stateTransitionIds: ['bad'] }),
    );

    await processHailMaryJob(
      makeJob({ user_message_id: 'mm-9' }),
      ds,
      makeUserService(jest.fn().mockResolvedValue({ id: 'u1' })),
      media,
      lesson,
      wabot,
    );

    expect(wabot.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rethrows + sets span ERROR when the wabot send call fails', async () => {
    const ds = {
      query: makeQuery([{ id: 'mm-9', created_at: new Date() }]),
    } as unknown as DataSource;
    const wabot = makeWabot(
      jest.fn().mockRejectedValue(new Error('wabot down')),
    );
    const media = makeMedia(
      jest.fn().mockResolvedValue({
        video: { wa_media_url: 'https://wa/v.mp4', media_details: null },
      }),
    );
    const lesson = makeLesson(
      jest.fn().mockResolvedValue({ stateTransitionIds: [] }),
    );

    await expect(
      processHailMaryJob(
        makeJob({ user_message_id: 'mm-9' }),
        ds,
        makeUserService(jest.fn().mockResolvedValue({ id: 'u1' })),
        media,
        lesson,
        wabot,
      ),
    ).rejects.toThrow('wabot down');

    expect(mockSpanSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'wabot down' }),
    );
    expect(mockSpanRecordException).toHaveBeenCalled();
  });
});
