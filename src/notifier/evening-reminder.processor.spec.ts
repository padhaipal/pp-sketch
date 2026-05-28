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

// ─── mutation hardening ────────────────────────────────────────────────────

import { Logger as NestLogger } from '@nestjs/common';

function spyLog() {
  return {
    log: jest.spyOn(NestLogger.prototype, 'log').mockImplementation(() => undefined),
    warn: jest.spyOn(NestLogger.prototype, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(NestLogger.prototype, 'error').mockImplementation(() => undefined),
  };
}

// Pull the mocked tracer so we can inspect its calls
const tracerMock = jest.requireMock('../otel/otel') as {
  tracer: { startActiveSpan: jest.Mock };
};

describe('processNotifierCronJob — span names + span attributes + log messages', () => {
  it('starts the cron span with name "notifier.cron" and sets bullmq.job.id', async () => {
    const ds = { query: makeQuery([], []) } as unknown as DataSource;
    await processNotifierCronJob(
      makeJob(),
      ds,
      makeLesson(jest.fn()),
      makeMedia(jest.fn()),
    );
    expect(tracerMock.tracer.startActiveSpan).toHaveBeenCalledWith(
      'notifier.cron',
      expect.any(Function),
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('bullmq.job.id', 'cron-1');
  });

  it('logs the cron-fired banner with 24h-back window and 5min-back idleSince ISO strings', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-15T18:00:00Z'));
    const { log } = spyLog();
    const ds = { query: makeQuery([], []) } as unknown as DataSource;
    await processNotifierCronJob(
      makeJob(),
      ds,
      makeLesson(jest.fn()),
      makeMedia(jest.fn()),
    );
    const expectedWindowStart = new Date(
      '2026-05-14T18:00:00Z',
    ).toISOString();
    const expectedIdleSince = new Date(
      '2026-05-15T17:55:00Z',
    ).toISOString();
    expect(log).toHaveBeenCalledWith(
      `Notifier cron fired. Window: ${expectedWindowStart} – ${expectedIdleSince}`,
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'notifier.window.start',
      expectedWindowStart,
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'notifier.idle_since',
      expectedIdleSince,
    );
    jest.useRealTimers();
    log.mockRestore();
  });

  it('tags notifier.skip_reason="no-active-users" and logs the empty-skip message', async () => {
    const { log } = spyLog();
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
    expect(log).toHaveBeenCalledWith(
      'No active users found in notification window — skipping.',
    );
    log.mockRestore();
  });

  it('tags notifier.skip_reason="no-videos" and logs the abort error when the video query returns nothing', async () => {
    const { error } = spyLog();
    const ds = {
      query: makeQuery(
        [{ user_id: 'u1', external_id: '919999990001', last_message_at: new Date(), last_message_id: 'mm-1' }],
        [], // videos
      ),
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
    expect(error).toHaveBeenCalledWith(
      'No evening_notification_message videos found with status=ready — aborting notification run.',
    );
    error.mockRestore();
  });

  it('issues the video-lookup SELECT with all four WHERE clauses verbatim', async () => {
    const query = makeQuery(
      [{ user_id: 'u1', external_id: '919999990001', last_message_at: new Date(), last_message_id: 'mm-1' }],
      [{ wa_media_url: 'wa://v1' }],
    );
    const ds = { query } as unknown as DataSource;
    await processNotifierCronJob(
      makeJob(),
      ds,
      makeLesson(jest.fn().mockResolvedValue({ stateTransitionIds: [] })),
      makeMedia(jest.fn()),
    );
    // Second call is the video lookup
    const sql = query.mock.calls[1][0] as string;
    expect(sql).toContain('SELECT wa_media_url');
    expect(sql).toContain('FROM media_metadata');
    expect(sql).toContain(
      "state_transition_id = 'evening_notification_message'",
    );
    expect(sql).toContain("media_type = 'video'");
    expect(sql).toContain("status = 'ready'");
    expect(sql).toContain('wa_media_url IS NOT NULL');
  });

  it('enqueues each send job with the literal name "send-notification" and tags enqueued.count', async () => {
    const { log } = spyLog();
    const ds = {
      query: makeQuery(
        [
          { user_id: 'u1', external_id: '919999990001', last_message_at: new Date(), last_message_id: 'mm-1' },
          { user_id: 'u2', external_id: '918888880002', last_message_at: new Date(), last_message_id: 'mm-2' },
        ],
        [{ wa_media_url: 'wa://v1' }],
      ),
    } as unknown as DataSource;
    await processNotifierCronJob(
      makeJob(),
      ds,
      makeLesson(jest.fn().mockResolvedValue({ stateTransitionIds: [] })),
      makeMedia(jest.fn()),
    );
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(mockQueueAdd.mock.calls[0][0]).toBe('send-notification');
    expect(mockQueueAdd.mock.calls[1][0]).toBe('send-notification');
    expect(mockCreateQueue).toHaveBeenCalledWith('notifier-send');
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'notifier.enqueued.count',
      2,
    );
    expect(log).toHaveBeenCalledWith(
      'Enqueued 2 notification-send jobs from 1 video(s).',
    );
    log.mockRestore();
  });
});

describe('processNotifierCronJob.buildUserMedia — span name + lesson.status attribute', () => {
  it('opens "notifier.buildUserMedia" span and tags notifier.lesson.status="ok" on success', async () => {
    const ds = {
      query: makeQuery(
        [{ user_id: 'u1', external_id: '919999990001', last_message_at: new Date(), last_message_id: 'mm-1' }],
        [{ wa_media_url: 'wa://v1' }],
      ),
    } as unknown as DataSource;
    const lesson = makeLesson(
      jest
        .fn()
        .mockResolvedValue({ stateTransitionIds: ['stid-1'] }),
    );
    const findMedia = jest.fn().mockResolvedValue({ text: undefined });
    await processNotifierCronJob(makeJob(), ds, lesson, makeMedia(findMedia));
    expect(tracerMock.tracer.startActiveSpan).toHaveBeenCalledWith(
      'notifier.buildUserMedia',
      expect.any(Function),
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'notifier.lesson.status',
      'ok',
    );
  });

  it('tags notifier.lesson.status="failed" and warns when processAnswer rejects', async () => {
    const { warn } = spyLog();
    const ds = {
      query: makeQuery(
        [{ user_id: 'u1', external_id: '919999990001', last_message_at: new Date(), last_message_id: 'mm-1' }],
        [{ wa_media_url: 'wa://v1' }],
      ),
    } as unknown as DataSource;
    const lesson = makeLesson(jest.fn().mockRejectedValue(new Error('lesson boom')));
    await processNotifierCronJob(makeJob(), ds, lesson, makeMedia(jest.fn()));
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'notifier.lesson.status',
      'failed',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Failed to create lesson for user .* lesson boom — sending notification video only/,
      ),
    );
    warn.mockRestore();
  });
});

describe('processNotifierSendJob — error_code branches + attributes', () => {
  const baseMedia: NotifierSendJobData = {
    user_external_id: '919999990001',
    media: [{ type: 'video', url: 'wa://v1' }],
  };

  it('opens "notifier.send" span and tags media.count + delivered=true on success', async () => {
    const { log } = spyLog();
    const wabot = makeWabot(
      jest.fn().mockResolvedValue({ delivered: true }),
    );
    await processNotifierSendJob(makeSendJob(baseMedia), wabot);
    expect(tracerMock.tracer.startActiveSpan).toHaveBeenCalledWith(
      'notifier.send',
      expect.any(Function),
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('notifier.media.count', 1);
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('notifier.delivered', true);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/Notification delivered to user /),
    );
    log.mockRestore();
  });

  it('on 130429: tags wabot.error_code and throws the rate-limit message', async () => {
    const wabot = makeWabot(
      jest.fn().mockResolvedValue({ delivered: false, error_code: 130429 }),
    );
    await expect(
      processNotifierSendJob(makeSendJob(baseMedia), wabot),
    ).rejects.toThrow(/WhatsApp rate-limit \(130429\)/);
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('wabot.error_code', 130429);
  });

  it('on 131047: tags notifier.skip_reason="window-expired" and returns silently', async () => {
    const { warn } = spyLog();
    const wabot = makeWabot(
      jest.fn().mockResolvedValue({ delivered: false, error_code: 131047 }),
    );
    await expect(
      processNotifierSendJob(makeSendJob(baseMedia), wabot),
    ).resolves.toBeUndefined();
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'notifier.skip_reason',
      'window-expired',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Notification undeliverable: 24-hour window expired \(131047\)/,
      ),
    );
    warn.mockRestore();
  });

  it('tags notifier.delivered=false when result.delivered is missing/falsy', async () => {
    const wabot = makeWabot(
      jest.fn().mockResolvedValue({ delivered: undefined }),
    );
    await expect(
      processNotifierSendJob(makeSendJob(baseMedia), wabot),
    ).rejects.toThrow(/Notification failed for user /);
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'notifier.delivered',
      false,
    );
  });

  it('error message on generic failure includes both status and error_code', async () => {
    const wabot = makeWabot(
      jest.fn().mockResolvedValue({
        delivered: false,
        status: 'rejected',
        error_code: 999,
      }),
    );
    await expect(
      processNotifierSendJob(makeSendJob(baseMedia), wabot),
    ).rejects.toThrow(/status=rejected error_code=999/);
  });
});
