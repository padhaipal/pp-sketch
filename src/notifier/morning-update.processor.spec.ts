process.env.LOG_PII_HMAC_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';

// uuid is ESM-only — provide a CJS-shaped mock. validate uses the loose
// hex-shape regex (no version/variant nibble checks) so test fixtures with
// arbitrary hex bytes still classify as uuids.
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'unused-mock-uuid'),
  validate: (s: unknown): boolean =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));

const mockQueueAdd = jest.fn();
const mockCreateQueue = jest.fn(() => ({ add: mockQueueAdd }));
jest.mock('../interfaces/redis/queues', () => ({
  createQueue: (...args: unknown[]) => mockCreateQueue(...args),
  QUEUE_NAMES: { MORNING_UPDATE_SEND: 'morning-update-send' },
}));

const mockSpanEnd = jest.fn();
const mockSpanSetAttribute = jest.fn();
const mockSpanSetStatus = jest.fn();
const mockSpanRecordException = jest.fn();
const mockInjectCarrier = jest.fn(() => ({ traceparent: 'tp' }));
const mockStartChildSpan = jest.fn(() => ({
  setAttribute: mockSpanSetAttribute,
  setStatus: mockSpanSetStatus,
  recordException: mockSpanRecordException,
  end: mockSpanEnd,
}));
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
  startChildSpan: (...args: unknown[]) => mockStartChildSpan(...args),
  injectCarrier: (...args: unknown[]) => mockInjectCarrier(...args),
}));

import { NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { DataSource, Repository } from 'typeorm';
import type { UserService } from '../users/user.service';
import type { MediaMetaDataService } from '../media-meta-data/media-meta-data.service';
import type { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';
import type { ReportCardService } from './report-card/report-card.service';
import type { MediaMetaDataEntity } from '../media-meta-data/media-meta-data.entity';
import {
  resolveMorningUpdateIntroMedia,
  enqueueMorningUpdateSend,
  triggerMorningUpdateForUser,
  processMorningUpdateCronJob,
  processMorningUpdateSendJob,
  MorningUpdateSendJobData,
} from './morning-update.processor';

function makeMedia(
  findMediaByStateTransitionId: jest.Mock,
  extra: Record<string, unknown> = {},
): MediaMetaDataService {
  return {
    findMediaByStateTransitionId,
    ...extra,
  } as unknown as MediaMetaDataService;
}
function makeUserService(findByIdOrExternalId: jest.Mock): UserService {
  return { findByIdOrExternalId } as unknown as UserService;
}
function makeWabot(sendNotification: jest.Mock): WabotOutboundService {
  return { sendNotification } as unknown as WabotOutboundService;
}
function makeReportCard(
  findExisting: jest.Mock,
  generatePng: jest.Mock,
): ReportCardService {
  return {
    findExistingForUser: findExisting,
    generatePng,
  } as unknown as ReportCardService;
}
function makeMediaRepo(findOneBy: jest.Mock): Repository<MediaMetaDataEntity> {
  return { findOneBy } as unknown as Repository<MediaMetaDataEntity>;
}

beforeEach(() => {
  mockQueueAdd.mockReset().mockResolvedValue({ id: 'job-99' });
  mockSpanEnd.mockReset();
  mockSpanSetAttribute.mockReset();
  mockSpanSetStatus.mockReset();
  mockSpanRecordException.mockReset();
  mockInjectCarrier.mockClear();
  mockStartChildSpan.mockClear();
  mockCreateQueue.mockClear();
});

describe('resolveMorningUpdateIntroMedia', () => {
  it('prefers video when both video and image are present', async () => {
    const svc = makeMedia(
      jest.fn().mockResolvedValue({
        video: {
          wa_media_url: 'https://v',
          media_details: { mime_type: 'video/mp4' },
        },
        image: {
          wa_media_url: 'https://i',
          media_details: { mime_type: 'image/png' },
        },
      }),
    );

    const out = await resolveMorningUpdateIntroMedia(svc);

    expect(out).toEqual([
      { type: 'video', url: 'https://v', mime_type: 'video/mp4' },
    ]);
  });

  it('falls back to image when only image is present', async () => {
    const svc = makeMedia(
      jest.fn().mockResolvedValue({
        image: {
          wa_media_url: 'https://i',
          media_details: { mime_type: 'image/png' },
        },
      }),
    );

    const out = await resolveMorningUpdateIntroMedia(svc);

    expect(out).toEqual([
      { type: 'image', url: 'https://i', mime_type: 'image/png' },
    ]);
  });

  it('returns null when neither video nor image is available', async () => {
    const svc = makeMedia(jest.fn().mockResolvedValue({}));
    await expect(resolveMorningUpdateIntroMedia(svc)).resolves.toBeNull();
  });

  it('returns image with undefined mime_type when media_details is null', async () => {
    const svc = makeMedia(
      jest.fn().mockResolvedValue({
        image: { wa_media_url: 'https://i', media_details: null },
      }),
    );
    const out = await resolveMorningUpdateIntroMedia(svc);
    expect(out).toEqual([
      { type: 'image', url: 'https://i', mime_type: undefined },
    ]);
  });
});

describe('enqueueMorningUpdateSend', () => {
  it('adds a job and returns its id as a string', async () => {
    mockQueueAdd.mockResolvedValue({ id: 123 });

    const id = await enqueueMorningUpdateSend({
      user_id: 'u1',
      user_external_id: '91999',
      intro_media: [{ type: 'video', url: 'https://v' }],
      otel_carrier: { traceparent: 'tp' },
    });

    expect(id).toBe('123');
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'morning-update-send',
      expect.objectContaining({
        user_id: 'u1',
        user_external_id: '91999',
        media: [{ type: 'video', url: 'https://v' }],
      }),
    );
  });
});

describe('triggerMorningUpdateForUser', () => {
  const UUID = '11111111-2222-3333-4444-555555555555';

  it('forwards the raw input verbatim to UserService.findByIdOrExternalId for both uuid and external_id forms', async () => {
    const userSvc = makeUserService(
      jest
        .fn()
        .mockResolvedValueOnce({ id: 'u1', external_id: '91999' })
        .mockResolvedValueOnce({ id: 'u1', external_id: '91999' }),
    );
    const mediaSvc = makeMedia(
      jest.fn().mockResolvedValue({
        image: { wa_media_url: 'https://i', media_details: null },
      }),
    );

    await triggerMorningUpdateForUser(UUID, userSvc, mediaSvc);
    expect((userSvc.findByIdOrExternalId as jest.Mock).mock.calls[0][0]).toBe(
      UUID,
    );

    await triggerMorningUpdateForUser('91999', userSvc, mediaSvc);
    expect((userSvc.findByIdOrExternalId as jest.Mock).mock.calls[1][0]).toBe(
      '91999',
    );
  });

  it('throws NotFoundException when user is not found', async () => {
    const userSvc = makeUserService(jest.fn().mockResolvedValue(null));
    const mediaSvc = makeMedia(jest.fn());

    await expect(
      triggerMorningUpdateForUser('91999', userSvc, mediaSvc),
    ).rejects.toThrow(NotFoundException);
    expect(mockSpanRecordException).toHaveBeenCalled();
  });

  it('throws when intro media is missing', async () => {
    const userSvc = makeUserService(
      jest.fn().mockResolvedValue({ id: 'u1', external_id: '91999' }),
    );
    const mediaSvc = makeMedia(jest.fn().mockResolvedValue({})); // no video, no image

    await expect(
      triggerMorningUpdateForUser('91999', userSvc, mediaSvc),
    ).rejects.toThrow('No morning_notification_message media');
  });

  it('happy path: returns {job_id, user_id, user_external_id}', async () => {
    const userSvc = makeUserService(
      jest.fn().mockResolvedValue({ id: 'u1', external_id: '91999' }),
    );
    const mediaSvc = makeMedia(
      jest.fn().mockResolvedValue({
        video: {
          wa_media_url: 'https://v',
          media_details: { mime_type: 'video/mp4' },
        },
      }),
    );
    mockQueueAdd.mockResolvedValue({ id: 'job-77' });

    const out = await triggerMorningUpdateForUser('91999', userSvc, mediaSvc);

    expect(out).toEqual({
      job_id: 'job-77',
      user_id: 'u1',
      user_external_id: '91999',
    });
  });
});

describe('processMorningUpdateCronJob', () => {
  function makeQuery(...rounds: unknown[][]): jest.Mock {
    const q = jest.fn();
    for (const r of rounds) q.mockResolvedValueOnce(r);
    return q;
  }

  it('skips when there are no active users', async () => {
    const ds = { query: makeQuery([]) } as unknown as DataSource;

    await processMorningUpdateCronJob(
      { id: 'cron-1' } as Job,
      ds,
      makeMedia(jest.fn()),
    );

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('skips with skip_reason=no-intro-media when intro media is missing', async () => {
    const ds = {
      query: makeQuery([
        {
          user_id: 'u1',
          external_id: '91999',
          last_message_at: new Date(),
          last_message_id: 'mm-1',
        },
      ]),
    } as unknown as DataSource;
    const mediaSvc = makeMedia(jest.fn().mockResolvedValue({})); // no media

    await processMorningUpdateCronJob({ id: 'cron-1' } as Job, ds, mediaSvc);

    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'morning_update.skip_reason',
      'no-intro-media',
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('enqueues one send job per active user when intro media is found', async () => {
    const ds = {
      query: makeQuery([
        {
          user_id: 'u1',
          external_id: '91111',
          last_message_at: new Date(),
          last_message_id: 'mm-1',
        },
        {
          user_id: 'u2',
          external_id: '92222',
          last_message_at: new Date(),
          last_message_id: 'mm-2',
        },
      ]),
    } as unknown as DataSource;
    const mediaSvc = makeMedia(
      jest.fn().mockResolvedValue({
        video: { wa_media_url: 'https://v', media_details: null },
      }),
    );

    await processMorningUpdateCronJob({ id: 'cron-1' } as Job, ds, mediaSvc);

    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'morning_update.enqueued.count',
      2,
    );
  });

  it('rethrows + records exception when getActiveUsers fails', async () => {
    const ds = {
      query: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as DataSource;

    await expect(
      processMorningUpdateCronJob(
        { id: 'cron-1' } as Job,
        ds,
        makeMedia(jest.fn()),
      ),
    ).rejects.toThrow('db down');
    expect(mockSpanRecordException).toHaveBeenCalled();
  });
});

describe('processMorningUpdateSendJob', () => {
  const baseData: MorningUpdateSendJobData = {
    user_id: 'u1',
    user_external_id: '91999',
    media: [{ type: 'video', url: 'https://intro' }],
    otel_carrier: { traceparent: 'parent' },
  };
  function makeSendJob(): Job<MorningUpdateSendJobData> {
    return {
      id: 'send-1',
      data: baseData,
    } as unknown as Job<MorningUpdateSendJobData>;
  }

  it('happy path: existing+ready report card → sends and returns', async () => {
    const report = makeReportCard(
      jest.fn().mockResolvedValue({ id: 'rc-1' }),
      jest.fn(),
    );
    const mediaRepo = makeMediaRepo(
      jest.fn().mockResolvedValue({
        id: 'rc-1',
        status: 'ready',
        wa_media_url: 'https://rc.png',
      }),
    );
    const wabot = makeWabot(
      jest.fn().mockResolvedValue({ delivered: true, status: 200 }),
    );
    const mediaSvc = makeMedia(jest.fn(), {
      createRenderedImageMedia: jest.fn(),
    });

    await processMorningUpdateSendJob(
      makeSendJob(),
      report,
      mediaSvc,
      mediaRepo,
      wabot,
    );

    expect(wabot.sendNotification).toHaveBeenCalledTimes(1);
    const sent = (wabot.sendNotification as jest.Mock).mock.calls[0][0];
    expect(sent.media).toEqual([
      { type: 'video', url: 'https://intro' },
      { type: 'image', url: 'https://rc.png', mime_type: 'image/png' },
      { type: 'text', body: 'https://dashboard.padhaipal.com/r/91999' },
    ]);
  });

  it('first-seen user (no existing row): renders + requeues with RequeueRequestedError', async () => {
    const generatePng = jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from('png') });
    const report = makeReportCard(
      jest.fn().mockResolvedValue(null),
      generatePng,
    );
    const createRenderedImageMedia = jest
      .fn()
      .mockResolvedValue({ status: 'queued' });
    const mediaSvc = makeMedia(jest.fn(), { createRenderedImageMedia });

    await expect(
      processMorningUpdateSendJob(
        makeSendJob(),
        report,
        mediaSvc,
        makeMediaRepo(jest.fn()),
        makeWabot(jest.fn()),
      ),
    ).rejects.toThrow(/requeue:.*just created/);

    expect(generatePng).toHaveBeenCalledWith('u1');
    expect(createRenderedImageMedia).toHaveBeenCalled();
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'morning_update.requeue',
      true,
    );
  });

  it('also requeues when existing row resolves to null on re-read', async () => {
    const generatePng = jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from('png') });
    const report = makeReportCard(
      jest.fn().mockResolvedValue({ id: 'rc-1' }),
      generatePng,
    );
    const mediaRepo = makeMediaRepo(jest.fn().mockResolvedValue(null));
    const mediaSvc = makeMedia(jest.fn(), {
      createRenderedImageMedia: jest
        .fn()
        .mockResolvedValue({ status: 'queued' }),
    });

    await expect(
      processMorningUpdateSendJob(
        makeSendJob(),
        report,
        mediaSvc,
        mediaRepo,
        makeWabot(jest.fn()),
      ),
    ).rejects.toThrow(/requeue/);
  });

  it('skips with image-failed when the report card status=failed', async () => {
    const report = makeReportCard(
      jest.fn().mockResolvedValue({ id: 'rc-1' }),
      jest.fn(),
    );
    const mediaRepo = makeMediaRepo(
      jest.fn().mockResolvedValue({ id: 'rc-1', status: 'failed' }),
    );
    const wabot = makeWabot(jest.fn());

    await processMorningUpdateSendJob(
      makeSendJob(),
      report,
      makeMedia(jest.fn(), { createRenderedImageMedia: jest.fn() }),
      mediaRepo,
      wabot,
    );

    expect(wabot.sendNotification).not.toHaveBeenCalled();
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'morning_update.skip_reason',
      'image-failed',
    );
  });

  it('requeues when report card status is something else (queued/pending)', async () => {
    const report = makeReportCard(
      jest.fn().mockResolvedValue({ id: 'rc-1' }),
      jest.fn(),
    );
    const mediaRepo = makeMediaRepo(
      jest.fn().mockResolvedValue({
        id: 'rc-1',
        status: 'queued',
        wa_media_url: null,
      }),
    );

    await expect(
      processMorningUpdateSendJob(
        makeSendJob(),
        report,
        makeMedia(jest.fn(), { createRenderedImageMedia: jest.fn() }),
        mediaRepo,
        makeWabot(jest.fn()),
      ),
    ).rejects.toThrow(/requeue: report card status=queued/);
  });

  it('also requeues when status=ready but wa_media_url is missing', async () => {
    const report = makeReportCard(
      jest.fn().mockResolvedValue({ id: 'rc-1' }),
      jest.fn(),
    );
    const mediaRepo = makeMediaRepo(
      jest.fn().mockResolvedValue({
        id: 'rc-1',
        status: 'ready',
        wa_media_url: null,
      }),
    );

    await expect(
      processMorningUpdateSendJob(
        makeSendJob(),
        report,
        makeMedia(jest.fn(), { createRenderedImageMedia: jest.fn() }),
        mediaRepo,
        makeWabot(jest.fn()),
      ),
    ).rejects.toThrow(/requeue/);
  });

  it('throws on 130429 rate-limit (retried by BullMQ)', async () => {
    const report = makeReportCard(
      jest.fn().mockResolvedValue({ id: 'rc-1' }),
      jest.fn(),
    );
    const mediaRepo = makeMediaRepo(
      jest.fn().mockResolvedValue({
        id: 'rc-1',
        status: 'ready',
        wa_media_url: 'https://rc.png',
      }),
    );
    const wabot = makeWabot(
      jest.fn().mockResolvedValue({
        delivered: false,
        status: 429,
        error_code: 130429,
      }),
    );

    await expect(
      processMorningUpdateSendJob(
        makeSendJob(),
        report,
        makeMedia(jest.fn(), { createRenderedImageMedia: jest.fn() }),
        mediaRepo,
        wabot,
      ),
    ).rejects.toThrow('WhatsApp rate-limit (130429)');
  });

  it('skips silently on 131047 window-expired', async () => {
    const report = makeReportCard(
      jest.fn().mockResolvedValue({ id: 'rc-1' }),
      jest.fn(),
    );
    const mediaRepo = makeMediaRepo(
      jest.fn().mockResolvedValue({
        id: 'rc-1',
        status: 'ready',
        wa_media_url: 'https://rc.png',
      }),
    );
    const wabot = makeWabot(
      jest.fn().mockResolvedValue({
        delivered: false,
        status: 200,
        error_code: 131047,
      }),
    );

    await processMorningUpdateSendJob(
      makeSendJob(),
      report,
      makeMedia(jest.fn(), { createRenderedImageMedia: jest.fn() }),
      mediaRepo,
      wabot,
    );

    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'morning_update.skip_reason',
      'window-expired',
    );
  });

  it('throws when delivered is falsy for any other reason', async () => {
    const report = makeReportCard(
      jest.fn().mockResolvedValue({ id: 'rc-1' }),
      jest.fn(),
    );
    const mediaRepo = makeMediaRepo(
      jest.fn().mockResolvedValue({
        id: 'rc-1',
        status: 'ready',
        wa_media_url: 'https://rc.png',
      }),
    );
    const wabot = makeWabot(
      jest
        .fn()
        .mockResolvedValue({ delivered: false, status: 500, error_code: 999 }),
    );

    await expect(
      processMorningUpdateSendJob(
        makeSendJob(),
        report,
        makeMedia(jest.fn(), { createRenderedImageMedia: jest.fn() }),
        mediaRepo,
        wabot,
      ),
    ).rejects.toThrow('Morning-update failed');
  });
});

// ─── mutation hardening ────────────────────────────────────────────────────

import { Logger as NestLogger } from '@nestjs/common';

function spyLog() {
  return {
    log: jest
      .spyOn(NestLogger.prototype, 'log')
      .mockImplementation(() => undefined),
    warn: jest
      .spyOn(NestLogger.prototype, 'warn')
      .mockImplementation(() => undefined),
    error: jest
      .spyOn(NestLogger.prototype, 'error')
      .mockImplementation(() => undefined),
  };
}

const tracerMock = jest.requireMock('../otel/otel');

describe('resolveMorningUpdateIntroMedia — exact stid lookup', () => {
  it('queries the "morning_notification_message" stid', async () => {
    const findMediaByStateTransitionId = jest.fn().mockResolvedValue({});
    await resolveMorningUpdateIntroMedia({
      findMediaByStateTransitionId,
    } as unknown as MediaMetaDataService);
    expect(findMediaByStateTransitionId).toHaveBeenCalledWith(
      'morning_notification_message',
    );
  });
});

describe('triggerMorningUpdateForUser — span + log + error path', () => {
  function userSvc(user: { id: string; external_id: string } | null) {
    return {
      findByIdOrExternalId: jest.fn().mockResolvedValue(user),
    } as unknown as UserService;
  }
  function mediaSvc(introResult: unknown) {
    return {
      findMediaByStateTransitionId: jest.fn().mockResolvedValue(introResult),
    } as unknown as MediaMetaDataService;
  }

  it('opens "morning-update.trigger" span and tags both bullmq.job.id and the external_id hash', async () => {
    await triggerMorningUpdateForUser(
      '919999990001',
      userSvc({ id: 'u1', external_id: '919999990001' }),
      mediaSvc({
        video: {
          wa_media_url: 'wa://v1',
          media_details: { mime_type: 'video/mp4' },
        },
      }),
    );
    expect(tracerMock.tracer.startActiveSpan).toHaveBeenCalledWith(
      'morning-update.trigger',
      expect.any(Function),
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'bullmq.job.id',
      expect.any(String),
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'morning_update.user.external_id_hash',
      expect.any(String),
    );
  });

  it('NotFoundException message format includes the hashed external_id', async () => {
    const svc = userSvc(null);
    await expect(
      triggerMorningUpdateForUser('919999990001', svc, mediaSvc({})),
    ).rejects.toThrow(/User not found for /);
  });

  it('aborts with the exact "No morning_notification_message media ..." error when intro lookup returns nothing', async () => {
    await expect(
      triggerMorningUpdateForUser(
        '919999990001',
        userSvc({ id: 'u1', external_id: '919999990001' }),
        mediaSvc({}),
      ),
    ).rejects.toThrow(
      'No morning_notification_message media (image or video) found with status=ready',
    );
  });

  it('prefers video over image in the intro media', async () => {
    await triggerMorningUpdateForUser(
      '919999990001',
      userSvc({ id: 'u1', external_id: '919999990001' }),
      mediaSvc({
        video: {
          wa_media_url: 'wa://v1',
          media_details: { mime_type: 'video/mp4' },
        },
        image: {
          wa_media_url: 'wa://i1',
          media_details: { mime_type: 'image/png' },
        },
      }),
    );
    const enqueued = mockQueueAdd.mock.calls[0][1] as MorningUpdateSendJobData;
    expect(enqueued.media).toEqual([
      { type: 'video', url: 'wa://v1', mime_type: 'video/mp4' },
    ]);
  });

  it('falls back to image when no video is available', async () => {
    await triggerMorningUpdateForUser(
      '919999990001',
      userSvc({ id: 'u1', external_id: '919999990001' }),
      mediaSvc({
        image: {
          wa_media_url: 'wa://i1',
          media_details: { mime_type: 'image/png' },
        },
      }),
    );
    const enqueued = mockQueueAdd.mock.calls[0][1] as MorningUpdateSendJobData;
    expect(enqueued.media).toEqual([
      { type: 'image', url: 'wa://i1', mime_type: 'image/png' },
    ]);
  });
});

describe('processMorningUpdateCronJob — span + skip-reasons + log messages', () => {
  function dsWith(activeUsers: unknown[]) {
    return {
      query: jest.fn().mockResolvedValue(activeUsers),
    } as unknown as DataSource;
  }

  it('opens the "morning-update.cron" span and tags bullmq.job.id, window.start, idle_since', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T01:30:00Z'));
    await processMorningUpdateCronJob(
      { id: 'cron-1' } as unknown as Job,
      dsWith([]),
      {
        findMediaByStateTransitionId: jest.fn().mockResolvedValue({}),
      } as unknown as MediaMetaDataService,
    );
    expect(tracerMock.tracer.startActiveSpan).toHaveBeenCalledWith(
      'morning-update.cron',
      expect.any(Function),
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'bullmq.job.id',
      'cron-1',
    );
    // 24h back and 5min back from system time
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'morning_update.window.start',
      new Date('2026-05-14T01:30:00Z').toISOString(),
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'morning_update.idle_since',
      new Date('2026-05-15T01:25:00Z').toISOString(),
    );
    jest.useRealTimers();
  });

  it('logs "No active users — skipping morning update." when active-users list is empty', async () => {
    const { log } = spyLog();
    await processMorningUpdateCronJob(
      { id: 'cron-1' } as unknown as Job,
      dsWith([]),
      {
        findMediaByStateTransitionId: jest.fn().mockResolvedValue({}),
      } as unknown as MediaMetaDataService,
    );
    expect(log).toHaveBeenCalledWith(
      'No active users — skipping morning update.',
    );
    log.mockRestore();
  });

  it('tags morning_update.skip_reason="no-intro-media" + logs the aborting error when intro media is missing', async () => {
    const { error } = spyLog();
    await processMorningUpdateCronJob(
      { id: 'cron-1' } as unknown as Job,
      dsWith([
        { user_id: 'u1', external_id: '919999990001', last_message_id: 'mm-1' },
      ]),
      {
        findMediaByStateTransitionId: jest.fn().mockResolvedValue({}),
      } as unknown as MediaMetaDataService,
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'morning_update.skip_reason',
      'no-intro-media',
    );
    expect(error).toHaveBeenCalledWith(
      'No morning_notification_message media (image or video) found with status=ready — aborting.',
    );
    error.mockRestore();
  });

  it('enqueues "morning-update-send" jobs and tags enqueued.count + logs total enqueued', async () => {
    const { log } = spyLog();
    await processMorningUpdateCronJob(
      { id: 'cron-1' } as unknown as Job,
      dsWith([
        { user_id: 'u1', external_id: '919999990001', last_message_id: 'mm-1' },
        { user_id: 'u2', external_id: '918888880002', last_message_id: 'mm-2' },
      ]),
      {
        findMediaByStateTransitionId: jest.fn().mockResolvedValue({
          video: {
            wa_media_url: 'wa://v1',
            media_details: { mime_type: 'video/mp4' },
          },
        }),
      } as unknown as MediaMetaDataService,
    );
    expect(mockCreateQueue).toHaveBeenCalledWith('morning-update-send');
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(mockQueueAdd.mock.calls[0][0]).toBe('morning-update-send');
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'morning_update.enqueued.count',
      2,
    );
    expect(log).toHaveBeenCalledWith('Enqueued 2 morning-update jobs.');
    log.mockRestore();
  });
});

describe('processMorningUpdateSendJob — child span + error_code branches + skip-reason', () => {
  function baseJob(): Job<MorningUpdateSendJobData> {
    return {
      id: 'send-1',
      data: {
        user_id: 'u1',
        user_external_id: '919999990001',
        media: [{ type: 'video', url: 'wa://v1', mime_type: 'video/mp4' }],
        otel_carrier: { traceparent: 'tp' },
      },
    } as unknown as Job<MorningUpdateSendJobData>;
  }

  it('opens "morning-update.send" CHILD span with the job otel_carrier (kills span name + carrier propagation)', async () => {
    const reportSvc = {
      findExistingForUser: jest.fn().mockResolvedValue({ id: 'mm-img' }),
      generatePng: jest.fn(),
    } as unknown as ReportCardService;
    const mediaRepo = {
      findOneBy: jest.fn().mockResolvedValue({
        id: 'mm-img',
        status: 'ready',
        wa_media_url: 'wa://img1',
      }),
    } as unknown as Repository<MediaMetaDataEntity>;
    const wabot = {
      sendNotification: jest.fn().mockResolvedValue({ delivered: true }),
    } as unknown as WabotOutboundService;
    await processMorningUpdateSendJob(
      baseJob(),
      reportSvc,
      {} as unknown as MediaMetaDataService,
      mediaRepo,
      wabot,
    );
    expect(mockStartChildSpan).toHaveBeenCalledWith('morning-update.send', {
      traceparent: 'tp',
    });
  });

  it('on 130429 throws the rate-limit error and tags wabot.error_code', async () => {
    const reportSvc = {
      findExistingForUser: jest.fn().mockResolvedValue({ id: 'mm-img' }),
    } as unknown as ReportCardService;
    const mediaRepo = {
      findOneBy: jest.fn().mockResolvedValue({
        id: 'mm-img',
        status: 'ready',
        wa_media_url: 'wa://img1',
      }),
    } as unknown as Repository<MediaMetaDataEntity>;
    const wabot = {
      sendNotification: jest
        .fn()
        .mockResolvedValue({ delivered: false, error_code: 130429 }),
    } as unknown as WabotOutboundService;
    await expect(
      processMorningUpdateSendJob(
        baseJob(),
        reportSvc,
        {} as unknown as MediaMetaDataService,
        mediaRepo,
        wabot,
      ),
    ).rejects.toThrow(/WhatsApp rate-limit \(130429\)/);
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'wabot.error_code',
      130429,
    );
  });

  it('on 131047 silently returns + tags morning_update.skip_reason="window-expired" + warns', async () => {
    const { warn } = spyLog();
    const reportSvc = {
      findExistingForUser: jest.fn().mockResolvedValue({ id: 'mm-img' }),
    } as unknown as ReportCardService;
    const mediaRepo = {
      findOneBy: jest.fn().mockResolvedValue({
        id: 'mm-img',
        status: 'ready',
        wa_media_url: 'wa://img1',
      }),
    } as unknown as Repository<MediaMetaDataEntity>;
    const wabot = {
      sendNotification: jest
        .fn()
        .mockResolvedValue({ delivered: false, error_code: 131047 }),
    } as unknown as WabotOutboundService;
    await expect(
      processMorningUpdateSendJob(
        baseJob(),
        reportSvc,
        {} as unknown as MediaMetaDataService,
        mediaRepo,
        wabot,
      ),
    ).resolves.toBeUndefined();
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'morning_update.skip_reason',
      'window-expired',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/24h window expired \(131047\)/),
    );
    warn.mockRestore();
  });

  it('full media payload = job.data.media + report-card image + referral text', async () => {
    const reportSvc = {
      findExistingForUser: jest.fn().mockResolvedValue({ id: 'mm-img' }),
    } as unknown as ReportCardService;
    const mediaRepo = {
      findOneBy: jest.fn().mockResolvedValue({
        id: 'mm-img',
        status: 'ready',
        wa_media_url: 'wa://img1',
      }),
    } as unknown as Repository<MediaMetaDataEntity>;
    const sendNotification = jest.fn().mockResolvedValue({ delivered: true });
    const wabot = { sendNotification } as unknown as WabotOutboundService;
    await processMorningUpdateSendJob(
      baseJob(),
      reportSvc,
      {} as unknown as MediaMetaDataService,
      mediaRepo,
      wabot,
    );
    const payload = sendNotification.mock.calls[0][0] as {
      user_external_id: string;
      media: OutboundMediaItem[];
    };
    expect(payload.user_external_id).toBe('919999990001');
    expect(payload.media).toEqual([
      { type: 'video', url: 'wa://v1', mime_type: 'video/mp4' }, // intro
      { type: 'image', url: 'wa://img1', mime_type: 'image/png' }, // report card
      {
        type: 'text',
        body: 'https://dashboard.padhaipal.com/r/919999990001',
      },
    ]);
  });

  it('on imageEntity.status==="failed" skips the send + tags morning_update.skip_reason="image-failed" + logs error', async () => {
    const { error } = spyLog();
    const reportSvc = {
      findExistingForUser: jest.fn().mockResolvedValue({ id: 'mm-img' }),
    } as unknown as ReportCardService;
    const mediaRepo = {
      findOneBy: jest
        .fn()
        .mockResolvedValue({ id: 'mm-img', status: 'failed' }),
    } as unknown as Repository<MediaMetaDataEntity>;
    const wabot = {
      sendNotification: jest.fn(),
    } as unknown as WabotOutboundService;
    await processMorningUpdateSendJob(
      baseJob(),
      reportSvc,
      {} as unknown as MediaMetaDataService,
      mediaRepo,
      wabot,
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'morning_update.skip_reason',
      'image-failed',
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /Morning-update report card media mm-img.*status=failed — skipping/,
      ),
    );
    expect(wabot.sendNotification).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
