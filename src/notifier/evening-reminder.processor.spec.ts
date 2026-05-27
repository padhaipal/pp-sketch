process.env.LOG_PII_HMAC_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';

const mockQueueAdd = jest.fn();
const mockCreateQueue = jest.fn(() => ({ add: mockQueueAdd }));
jest.mock('../interfaces/redis/queues', () => ({
  createQueue: (...args: unknown[]) => mockCreateQueue(...args),
  QUEUE_NAMES: { NOTIFIER_SEND: 'notifier-send' },
}));

const mockSpanEnd = jest.fn();
const mockSpanSetAttribute = jest.fn();
const mockSpanSetStatus = jest.fn();
const mockSpanRecordException = jest.fn();
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
}));

import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import type { LiteracyLessonService } from '../literacy/literacy-lesson/literacy-lesson.service';
import type { MediaMetaDataService } from '../media-meta-data/media-meta-data.service';
import type { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';
import {
  NotifierSendJobData,
  processNotifierCronJob,
  processNotifierSendJob,
} from './evening-reminder.processor';

function makeJob(): Job {
  return { id: 'cron-1' } as unknown as Job;
}
function makeSendJob(data: NotifierSendJobData): Job<NotifierSendJobData> {
  return { id: 'send-1', data } as unknown as Job<NotifierSendJobData>;
}

function makeQuery(...rounds: unknown[][]): jest.Mock {
  const q = jest.fn();
  for (const r of rounds) q.mockResolvedValueOnce(r);
  return q;
}

function makeMedia(findMediaByStateTransitionId: jest.Mock): MediaMetaDataService {
  return {
    findMediaByStateTransitionId,
  } as unknown as MediaMetaDataService;
}
function makeLesson(processAnswer: jest.Mock): LiteracyLessonService {
  return { processAnswer } as unknown as LiteracyLessonService;
}
function makeWabot(sendNotification: jest.Mock): WabotOutboundService {
  return { sendNotification } as unknown as WabotOutboundService;
}

beforeEach(() => {
  mockQueueAdd.mockReset().mockResolvedValue(undefined);
  mockSpanEnd.mockReset();
  mockSpanSetAttribute.mockReset();
  mockSpanSetStatus.mockReset();
  mockSpanRecordException.mockReset();
  mockCreateQueue.mockClear();
});

describe('processNotifierCronJob', () => {
  it('skips when there are no active users', async () => {
    const ds = { query: makeQuery([]) } as unknown as DataSource;

    await processNotifierCronJob(
      makeJob(),
      ds,
      makeLesson(jest.fn()),
      makeMedia(jest.fn()),
    );

    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'notifier.skip_reason',
      'no-active-users',
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('skips when no evening_notification_message videos are ready', async () => {
    const activeUsers = [
      {
        user_id: 'u1',
        external_id: '91999',
        last_message_at: new Date(),
        last_message_id: 'mm-1',
      },
    ];
    const ds = {
      query: makeQuery(activeUsers, [] /* no videos */),
    } as unknown as DataSource;

    await processNotifierCronJob(
      makeJob(),
      ds,
      makeLesson(jest.fn()),
      makeMedia(jest.fn()),
    );

    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'notifier.skip_reason',
      'no-videos',
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('enqueues one send job per active user, sorted by oldest last_message_at first', async () => {
    const u1 = {
      user_id: 'u1',
      external_id: '91111',
      last_message_at: new Date('2026-04-27T10:00:00Z'),
      last_message_id: 'mm-1',
    };
    const u2 = {
      user_id: 'u2',
      external_id: '92222',
      last_message_at: new Date('2026-04-27T08:00:00Z'),
      last_message_id: 'mm-2',
    };
    const ds = {
      query: makeQuery([u1, u2], [{ wa_media_url: 'https://v1' }]),
    } as unknown as DataSource;
    const lesson = makeLesson(
      jest.fn().mockResolvedValue({ stateTransitionIds: [] }),
    );

    await processNotifierCronJob(
      makeJob(),
      ds,
      lesson,
      makeMedia(jest.fn()),
    );

    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    // First call should be u2 (older last_message_at => sooner expiry)
    expect((mockQueueAdd.mock.calls[0][1] as NotifierSendJobData).user_external_id).toBe(
      '92222',
    );
    expect((mockQueueAdd.mock.calls[1][1] as NotifierSendJobData).user_external_id).toBe(
      '91111',
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'notifier.enqueued.count',
      2,
    );
  });

  it('tolerates per-user lesson failure — still enqueues with the notification video only', async () => {
    const u1 = {
      user_id: 'u1',
      external_id: '91111',
      last_message_at: new Date(),
      last_message_id: 'mm-1',
    };
    const ds = {
      query: makeQuery([u1], [{ wa_media_url: 'https://v1' }]),
    } as unknown as DataSource;
    const lesson = makeLesson(
      jest.fn().mockRejectedValue(new Error('lesson down')),
    );

    await processNotifierCronJob(
      makeJob(),
      ds,
      lesson,
      makeMedia(jest.fn()),
    );

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const sentMedia = (mockQueueAdd.mock.calls[0][1] as NotifierSendJobData).media;
    expect(sentMedia).toEqual([{ type: 'video', url: 'https://v1' }]);
  });

  it('appends lesson-stid media when processAnswer succeeds', async () => {
    const u1 = {
      user_id: 'u1',
      external_id: '91111',
      last_message_at: new Date(),
      last_message_id: 'mm-1',
    };
    const ds = {
      query: makeQuery([u1], [{ wa_media_url: 'https://v1' }]),
    } as unknown as DataSource;
    const lesson = makeLesson(
      jest.fn().mockResolvedValue({ stateTransitionIds: ['ok'] }),
    );
    const media = makeMedia(
      jest.fn().mockResolvedValue({
        audio: {
          wa_media_url: 'https://a1',
          media_details: { mime_type: 'audio/mpeg' },
        },
        text: { text: 'nice' },
      }),
    );

    await processNotifierCronJob(makeJob(), ds, lesson, media);

    const sentMedia = (mockQueueAdd.mock.calls[0][1] as NotifierSendJobData).media;
    expect(sentMedia).toEqual([
      { type: 'video', url: 'https://v1' },
      { type: 'audio', url: 'https://a1', mime_type: 'audio/mpeg' },
      { type: 'text', body: 'nice' },
    ]);
  });

  it('rethrows + records exception when the active-users query fails', async () => {
    const ds = {
      query: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as DataSource;

    await expect(
      processNotifierCronJob(
        makeJob(),
        ds,
        makeLesson(jest.fn()),
        makeMedia(jest.fn()),
      ),
    ).rejects.toThrow('db down');
    expect(mockSpanRecordException).toHaveBeenCalled();
  });
});

describe('processNotifierSendJob', () => {
  const baseData: NotifierSendJobData = {
    user_external_id: '91999',
    media: [{ type: 'video', url: 'https://v' }],
  };

  it('logs success when sendNotification returns delivered:true', async () => {
    const wabot = makeWabot(
      jest.fn().mockResolvedValue({ delivered: true, status: 200 }),
    );
    await processNotifierSendJob(makeSendJob(baseData), wabot);
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('notifier.delivered', true);
  });

  it('throws on 130429 rate-limit', async () => {
    const wabot = makeWabot(
      jest
        .fn()
        .mockResolvedValue({ delivered: false, status: 429, error_code: 130429 }),
    );
    await expect(
      processNotifierSendJob(makeSendJob(baseData), wabot),
    ).rejects.toThrow('WhatsApp rate-limit (130429)');
  });

  it('silently skips on 131047 window-expired (no throw)', async () => {
    const wabot = makeWabot(
      jest
        .fn()
        .mockResolvedValue({ delivered: false, status: 200, error_code: 131047 }),
    );
    await expect(
      processNotifierSendJob(makeSendJob(baseData), wabot),
    ).resolves.toBeUndefined();
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'notifier.skip_reason',
      'window-expired',
    );
  });

  it('throws when delivered is falsy for any other reason', async () => {
    const wabot = makeWabot(
      jest
        .fn()
        .mockResolvedValue({ delivered: false, status: 500, error_code: 999 }),
    );
    await expect(
      processNotifierSendJob(makeSendJob(baseData), wabot),
    ).rejects.toThrow('Notification failed');
  });

  it('rethrows and records exception when the wabot call itself rejects', async () => {
    const wabot = makeWabot(jest.fn().mockRejectedValue(new Error('netfail')));
    await expect(
      processNotifierSendJob(makeSendJob(baseData), wabot),
    ).rejects.toThrow('netfail');
    expect(mockSpanRecordException).toHaveBeenCalled();
  });
});
