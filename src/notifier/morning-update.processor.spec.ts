process.env.LOG_PII_HMAC_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';

// uuid is ESM-only — transitively imported via MediaMetaDataService.
jest.mock('uuid', () => ({ v4: jest.fn(() => 'unused-mock-uuid') }));

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

function makeMedia(findMediaByStateTransitionId: jest.Mock, extra: Record<string, unknown> = {}): MediaMetaDataService {
  return {
    findMediaByStateTransitionId,
    ...extra,
  } as unknown as MediaMetaDataService;
}
function makeUserService(find: jest.Mock): UserService {
  return { find } as unknown as UserService;
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
        video: { wa_media_url: 'https://v', media_details: { mime_type: 'video/mp4' } },
        image: { wa_media_url: 'https://i', media_details: { mime_type: 'image/png' } },
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
        image: { wa_media_url: 'https://i', media_details: { mime_type: 'image/png' } },
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
    expect(out).toEqual([{ type: 'image', url: 'https://i', mime_type: undefined }]);
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

  it('routes UUID inputs through {id} lookup; non-UUID through {external_id}', async () => {
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
    expect((userSvc.find as jest.Mock).mock.calls[0][0]).toEqual({ id: UUID });

    await triggerMorningUpdateForUser('91999', userSvc, mediaSvc);
    expect((userSvc.find as jest.Mock).mock.calls[1][0]).toEqual({
      external_id: '91999',
    });
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

    await processMorningUpdateCronJob(
      { id: 'cron-1' } as Job,
      ds,
      mediaSvc,
    );

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

    await processMorningUpdateCronJob(
      { id: 'cron-1' } as Job,
      ds,
      mediaSvc,
    );

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
    return { id: 'send-1', data: baseData } as unknown as Job<MorningUpdateSendJobData>;
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
    const report = makeReportCard(jest.fn().mockResolvedValue(null), generatePng);
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
      createRenderedImageMedia: jest.fn().mockResolvedValue({ status: 'queued' }),
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
      jest
        .fn()
        .mockResolvedValue({ delivered: false, status: 429, error_code: 130429 }),
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
      jest
        .fn()
        .mockResolvedValue({ delivered: false, status: 200, error_code: 131047 }),
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
