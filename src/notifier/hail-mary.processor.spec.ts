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
function makeMedia(
  findMediaByStateTransitionId: jest.Mock,
): MediaMetaDataService {
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

// ─── mutation hardening ────────────────────────────────────────────────────

import { Logger as NestLogger } from '@nestjs/common';

function spyLog2() {
  return {
    log: jest
      .spyOn(NestLogger.prototype, 'log')
      .mockImplementation(() => undefined),
    warn: jest
      .spyOn(NestLogger.prototype, 'warn')
      .mockImplementation(() => undefined),
  };
}
const tracerMock2 = jest.requireMock('../otel/otel');

describe('hail-mary — constants + exports', () => {
  it('HAIL_MARY_DELAY_MS is 1435 minutes = 23h55m', () => {
    expect(HAIL_MARY_DELAY_MS).toBe(1435 * 60 * 1000);
    expect(HAIL_MARY_DELAY_MS).toBe(23 * 60 * 60 * 1000 + 55 * 60 * 1000);
  });
});

describe('rearmHailMary — exact queue call shape', () => {
  it('removes the prior job by id then adds with the same id + delay', async () => {
    mockQueueRemove.mockResolvedValue(undefined);
    mockQueueAdd.mockResolvedValue({ id: 'queued' });
    const data = {
      user_id: 'u1',
      user_external_id: '919999990001',
      user_message_id: 'mm-1',
      otel_carrier: { traceparent: 'tp' },
    };
    await rearmHailMary(data);
    expect(mockCreateQueue).toHaveBeenCalledWith('hail-mary');
    expect(mockQueueRemove).toHaveBeenCalledWith('hail-mary:u1');
    expect(mockQueueAdd).toHaveBeenCalledWith('hail-mary', data, {
      jobId: 'hail-mary:u1',
      delay: HAIL_MARY_DELAY_MS,
    });
  });
});

describe('processHailMaryJob — span name + attributes + log messages', () => {
  function dsWith(rows: unknown[]) {
    return {
      query: jest.fn().mockResolvedValue(rows),
    } as unknown as DataSource;
  }

  function makeJob2(data: Partial<HailMaryJobData> = {}): Job<HailMaryJobData> {
    return {
      id: 'job-1',
      data: {
        user_id: 'u1',
        user_external_id: '919999990001',
        user_message_id: 'mm-1',
        otel_carrier: { traceparent: 'tp' },
        ...data,
      },
    } as unknown as Job<HailMaryJobData>;
  }

  it('opens "hail-mary.send" span and tags bullmq.job.id + user/source hashes', async () => {
    await processHailMaryJob(
      makeJob2(),
      dsWith([]),
      { find: jest.fn() } as unknown as UserService,
      {} as unknown as MediaMetaDataService,
      {} as unknown as LiteracyLessonService,
      {} as unknown as WabotOutboundService,
    );
    expect(tracerMock2.tracer.startActiveSpan).toHaveBeenCalledWith(
      'hail-mary.send',
      expect.any(Function),
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('bullmq.job.id', 'job-1');
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'user_id_hash',
      expect.any(String),
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'source_msg_id_hash',
      expect.any(String),
    );
  });

  it('latest-message SQL filters source=whatsapp + rolled_back=false and ORDER BY created_at DESC LIMIT 1', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await processHailMaryJob(
      makeJob2(),
      { query } as unknown as DataSource,
      { find: jest.fn() } as unknown as UserService,
      {} as unknown as MediaMetaDataService,
      {} as unknown as LiteracyLessonService,
      {} as unknown as WabotOutboundService,
    );
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('FROM media_metadata');
    expect(sql).toContain('WHERE user_id = $1');
    expect(sql).toContain("source = 'whatsapp'");
    expect(sql).toContain('rolled_back = false');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).toContain('LIMIT 1');
    expect(query.mock.calls[0][1]).toEqual(['u1']);
  });

  it('on no-message: warns + tags hail_mary.skip_reason="no-latest-message"', async () => {
    const { warn } = spyLog2();
    await processHailMaryJob(
      makeJob2(),
      dsWith([]),
      { find: jest.fn() } as unknown as UserService,
      {} as unknown as MediaMetaDataService,
      {} as unknown as LiteracyLessonService,
      {} as unknown as WabotOutboundService,
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'hail_mary.skip_reason',
      'no-latest-message',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /hail-mary: no whatsapp messages for user .* — skipping/,
      ),
    );
    warn.mockRestore();
  });

  it('on stale chain: warns + tags hail_mary.skip_reason="stale"', async () => {
    const { warn } = spyLog2();
    mockQueueGetJob.mockResolvedValueOnce(null);
    mockQueueRemove.mockResolvedValue(undefined);
    mockQueueAdd.mockResolvedValue({ id: 'new' });
    await processHailMaryJob(
      makeJob2(),
      dsWith([{ id: 'mm-newer', created_at: new Date() }]),
      { find: jest.fn() } as unknown as UserService,
      {} as unknown as MediaMetaDataService,
      {} as unknown as LiteracyLessonService,
      {} as unknown as WabotOutboundService,
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'hail_mary.skip_reason',
      'stale',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/hail-mary: rearm chain broke for user /),
    );
    warn.mockRestore();
  });

  it('on 24h window expired: warns + tags hail_mary.skip_reason="window-expired"', async () => {
    const { warn } = spyLog2();
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    await processHailMaryJob(
      makeJob2(),
      dsWith([{ id: 'mm-1', created_at: staleDate }]),
      { find: jest.fn() } as unknown as UserService,
      {} as unknown as MediaMetaDataService,
      {} as unknown as LiteracyLessonService,
      {} as unknown as WabotOutboundService,
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'hail_mary.skip_reason',
      'window-expired',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/hail-mary: 24h window expired for user /),
    );
    warn.mockRestore();
  });

  it('on user not found: warns + tags hail_mary.skip_reason="user-not-found"', async () => {
    const { warn } = spyLog2();
    await processHailMaryJob(
      makeJob2(),
      dsWith([{ id: 'mm-1', created_at: new Date() }]),
      { find: jest.fn().mockResolvedValue(null) } as unknown as UserService,
      {} as unknown as MediaMetaDataService,
      {} as unknown as LiteracyLessonService,
      {} as unknown as WabotOutboundService,
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'hail_mary.skip_reason',
      'user-not-found',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/hail-mary: user .* not found — skipping/),
    );
    warn.mockRestore();
  });

  it('on empty media: warns + tags hail_mary.skip_reason="no-media"', async () => {
    const { warn } = spyLog2();
    await processHailMaryJob(
      makeJob2(),
      dsWith([{ id: 'mm-1', created_at: new Date() }]),
      {
        find: jest
          .fn()
          .mockResolvedValue({ id: 'u1', external_id: '919999990001' }),
      } as unknown as UserService,
      {
        findMediaByStateTransitionId: jest.fn().mockResolvedValue({}),
      } as unknown as MediaMetaDataService,
      {
        processAnswer: jest.fn().mockResolvedValue({ stateTransitionIds: [] }),
      } as unknown as LiteracyLessonService,
      {} as unknown as WabotOutboundService,
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'hail_mary.skip_reason',
      'no-media',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/hail-mary: no media to send for user /),
    );
    warn.mockRestore();
  });

  it('on success: sends to wabot with wamid="" + the assembled media + logs the delivery log', async () => {
    const { log } = spyLog2();
    const sendMessage = jest.fn().mockResolvedValue({ status: 200 });
    await processHailMaryJob(
      makeJob2(),
      dsWith([{ id: 'mm-1', created_at: new Date() }]),
      {
        find: jest
          .fn()
          .mockResolvedValue({ id: 'u1', external_id: '919999990001' }),
      } as unknown as UserService,
      {
        findMediaByStateTransitionId: jest.fn().mockResolvedValue({
          video: {
            wa_media_url: 'wa://v1',
            media_details: { mime_type: 'video/mp4' },
          },
        }),
      } as unknown as MediaMetaDataService,
      {
        processAnswer: jest.fn().mockResolvedValue({ stateTransitionIds: [] }),
      } as unknown as LiteracyLessonService,
      { sendMessage } as unknown as WabotOutboundService,
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        user_external_id: '919999990001',
        wamid: '',
        media: expect.arrayContaining([
          expect.objectContaining({ type: 'video', url: 'wa://v1' }),
        ]),
      }),
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'http.response.status_code',
      200,
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/hail-mary: sent to user .* status=200/),
    );
    log.mockRestore();
  });

  it('looks up hail-mary stid for the intro media (kills the HAIL_MARY_STATE_TRANSITION_ID constant)', async () => {
    const findMediaByStateTransitionId = jest.fn().mockResolvedValue({});
    await processHailMaryJob(
      makeJob2(),
      dsWith([{ id: 'mm-1', created_at: new Date() }]),
      {
        find: jest
          .fn()
          .mockResolvedValue({ id: 'u1', external_id: '919999990001' }),
      } as unknown as UserService,
      {
        findMediaByStateTransitionId,
      } as unknown as MediaMetaDataService,
      {
        processAnswer: jest.fn().mockResolvedValue({ stateTransitionIds: [] }),
      } as unknown as LiteracyLessonService,
      { sendMessage: jest.fn() } as unknown as WabotOutboundService,
    );
    // The first call to findMediaByStateTransitionId is the hail-mary stid.
    expect(findMediaByStateTransitionId).toHaveBeenCalledWith('hail-mary');
  });
});
