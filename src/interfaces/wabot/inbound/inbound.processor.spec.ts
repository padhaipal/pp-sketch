process.env.LOG_PII_HMAC_KEY = process.env.LOG_PII_HMAC_KEY ?? 'a'.repeat(64);

import { Job } from 'bullmq';
import { processWabotInboundJob } from './inbound.processor';
import { MessageJobDto } from './wabot-inbound.dto';

jest.mock('../../../notifier/hail-mary.processor', () => ({
  rearmHailMary: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../otel/otel', () => ({
  startChildSpanWithContext: jest.fn(() => ({
    span: {
      setAttribute: jest.fn(),
      setStatus: jest.fn(),
      recordException: jest.fn(),
      end: jest.fn(),
    },
    ctx: {},
  })),
  injectCarrier: jest.fn(() => ({})),
  injectCarrierFromContext: jest.fn(() => ({})),
}));

jest.mock('../../../otel/metrics', () => ({
  wabotInboundJobDuration: { record: jest.fn() },
}));

function createAudioJob(
  overrides: { attemptsMade?: number } = {},
): Job<MessageJobDto> {
  return {
    data: {
      message: {
        from: '+910000000001',
        id: 'wamid-test-1',
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'audio',
        audio: { url: 'https://example.com/audio' },
      },
      otel: { carrier: {} },
    } as any,
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: 3 },
  } as any;
}

function makeMocks(
  opts: { isComplete?: boolean; crossedQuota?: boolean } = {},
) {
  const user = { id: 'user-1', external_id: '+910000000001' };
  const audioEntity = { id: 'audio-entity-1' };

  const userService = {
    find: jest.fn().mockResolvedValue(user),
    create: jest.fn(),
    update: jest.fn(),
  };
  const mediaMetaDataService = {
    createWhatsappAudioMedia: jest.fn().mockResolvedValue(audioEntity),
    findTranscripts: jest.fn().mockResolvedValue([{ text: 'ओम' }]),
    findMediaByStateTransitionId: jest.fn().mockResolvedValue({}),
    markRolledBack: jest.fn().mockResolvedValue(undefined),
    createTextMedia: jest.fn(),
  };
  const literacyLessonService = {
    processAnswer: jest.fn().mockResolvedValue({
      stateTransitionIds: ['sid-1'],
      isComplete: opts.isComplete ?? false,
    }),
    cleanupPartialState: jest.fn().mockResolvedValue(undefined),
  };
  const wabotOutbound = {
    sendMessage: jest
      .fn()
      .mockResolvedValue({ status: 200, body: { delivered: true } }),
  };
  const userActivityService = {
    didJustCrossDailyActivityThreshold: jest
      .fn()
      .mockResolvedValue(opts.crossedQuota ?? false),
  };

  return {
    userService,
    mediaMetaDataService,
    literacyLessonService,
    wabotOutbound,
    userActivityService,
  };
}

async function runJob(
  job: Job<MessageJobDto>,
  mocks: ReturnType<typeof makeMocks>,
): Promise<void> {
  await processWabotInboundJob(
    job,
    mocks.userService as any,
    mocks.mediaMetaDataService as any,
    mocks.literacyLessonService as any,
    mocks.wabotOutbound as any,
    mocks.userActivityService as any,
  );
}

describe('processWabotInboundJob — cleanupPartialState on retry', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('does not call cleanupPartialState on first attempt', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob({ attemptsMade: 0 }), mocks);

    expect(
      mocks.literacyLessonService.cleanupPartialState,
    ).not.toHaveBeenCalled();
    expect(mocks.literacyLessonService.processAnswer).toHaveBeenCalledTimes(1);
  });

  it('calls cleanupPartialState exactly once on retry with the audio entity id', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob({ attemptsMade: 1 }), mocks);

    expect(
      mocks.literacyLessonService.cleanupPartialState,
    ).toHaveBeenCalledTimes(1);
    expect(
      mocks.literacyLessonService.cleanupPartialState,
    ).toHaveBeenCalledWith('audio-entity-1');
  });

  it('calls cleanupPartialState before processAnswer on retry', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob({ attemptsMade: 1 }), mocks);

    const cleanupOrder =
      mocks.literacyLessonService.cleanupPartialState.mock
        .invocationCallOrder[0];
    const processOrder =
      mocks.literacyLessonService.processAnswer.mock.invocationCallOrder[0];

    expect(cleanupOrder).toBeDefined();
    expect(processOrder).toBeDefined();
    expect(cleanupOrder).toBeLessThan(processOrder);
  });

  it('calls cleanupPartialState only once on retry even when processAnswer completes and triggers the fresh-start second call', async () => {
    const mocks = makeMocks({ isComplete: true });
    await runJob(createAudioJob({ attemptsMade: 2 }), mocks);

    expect(
      mocks.literacyLessonService.cleanupPartialState,
    ).toHaveBeenCalledTimes(1);
    expect(mocks.literacyLessonService.processAnswer).toHaveBeenCalledTimes(2);
  });
});

// ─── Builders for non-audio scenarios ───────────────────────────────────────

function makeSystemJob(): Job<MessageJobDto> {
  return {
    data: {
      message: {
        from: '+910000000001',
        id: 'wamid-sys-1',
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'system',
        system: { body: 'phone changed', wa_id: '+910000000002' },
      },
      otel: { carrier: {} },
    } as any,
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as any;
}

function makeTextJob(body: string, opts: { consecutive?: boolean } = {}): Job<MessageJobDto> {
  return {
    data: {
      message: {
        from: '+910000000001',
        id: 'wamid-text-1',
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body },
      },
      otel: { carrier: {} },
      ...(opts.consecutive !== undefined ? { consecutive: opts.consecutive } : {}),
    } as any,
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as any;
}

function makeVideoJob(): Job<MessageJobDto> {
  return {
    data: {
      message: {
        from: '+910000000001',
        id: 'wamid-vid-1',
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'video',
        video: { url: 'https://wa/v.mp4' },
      },
      otel: { carrier: {} },
    } as any,
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as any;
}

describe('processWabotInboundJob — system messages (phone change)', () => {
  afterEach(() => jest.clearAllMocks());

  it('updates the user external_id and short-circuits before touching media', async () => {
    const mocks = makeMocks();
    mocks.userService.update.mockResolvedValue({
      id: 'u1',
      external_id: '+910000000002',
    });

    await runJob(makeSystemJob(), mocks);

    expect(mocks.userService.update).toHaveBeenCalledWith({
      external_id: '+910000000001',
      new_external_id: '+910000000002',
    });
    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).not.toHaveBeenCalled();
    expect(mocks.wabotOutbound.sendMessage).not.toHaveBeenCalled();
  });

  it('throws when the user to update is not found', async () => {
    const mocks = makeMocks();
    mocks.userService.update.mockResolvedValue(null);

    await expect(runJob(makeSystemJob(), mocks)).rejects.toThrow(
      'User not found for phone number change',
    );
  });
});

describe('processWabotInboundJob — consecutive messages', () => {
  afterEach(() => jest.clearAllMocks());

  it('skips silently without calling any downstream service', async () => {
    const mocks = makeMocks();
    await runJob(makeTextJob('hi', { consecutive: true }), mocks);

    expect(mocks.userService.find).not.toHaveBeenCalled();
    expect(mocks.wabotOutbound.sendMessage).not.toHaveBeenCalled();
  });
});

describe('processWabotInboundJob — new user onboarding', () => {
  afterEach(() => jest.clearAllMocks());

  it('creates a user without referrer when text has no parseable number', async () => {
    const mocks = makeMocks();
    mocks.userService.find.mockResolvedValueOnce(null); // self lookup misses
    mocks.userService.create.mockResolvedValue({
      id: 'u-new',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.createTextMedia.mockResolvedValue({
      id: 'text-1',
    });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({});

    await runJob(makeTextJob('hello world'), mocks);

    expect(mocks.userService.create).toHaveBeenCalledWith({
      external_id: '+910000000001',
      referrer_external_id: undefined,
    });
    expect(mocks.wabotOutbound.sendMessage).toHaveBeenCalled();
    // referral link must be present
    const media = (mocks.wabotOutbound.sendMessage.mock.calls[0][0] as {
      media: { type: string; body?: string }[];
    }).media;
    expect(
      media.some(
        (m) =>
          m.type === 'text' &&
          typeof m.body === 'string' &&
          m.body.includes('dashboard.padhaipal.com/r/+910000000001'),
      ),
    ).toBe(true);
  });

  it('parses a referrer phone from the text body and uses it when found', async () => {
    const mocks = makeMocks();
    // Self lookup misses, referrer lookup hits
    mocks.userService.find
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'ref-1', external_id: '+919999999999' });
    mocks.userService.create.mockResolvedValue({
      id: 'u-new',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.createTextMedia.mockResolvedValue({
      id: 'text-1',
    });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({});

    await runJob(makeTextJob('thanks 9999999999'), mocks);

    expect(mocks.userService.create).toHaveBeenCalledWith({
      external_id: '+910000000001',
      referrer_external_id: '+919999999999',
    });
  });

  it('falls back to no-referrer when the parsed referrer is not found in DB', async () => {
    const mocks = makeMocks();
    mocks.userService.find
      .mockResolvedValueOnce(null) // self miss
      .mockResolvedValueOnce(null); // referrer miss
    mocks.userService.create.mockResolvedValue({
      id: 'u-new',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.createTextMedia.mockResolvedValue({
      id: 'text-1',
    });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({});

    await runJob(makeTextJob('thanks 9999999999'), mocks);

    expect(mocks.userService.create).toHaveBeenCalledWith({
      external_id: '+910000000001',
      referrer_external_id: undefined,
    });
  });

  it('sends a fallback message and rethrows when user creation fails', async () => {
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/fallback.mp4';
    const mocks = makeMocks();
    mocks.userService.find.mockResolvedValueOnce(null);
    mocks.userService.create.mockRejectedValue(new Error('DB constraint'));

    await expect(runJob(makeTextJob('hi'), mocks)).rejects.toThrow(
      'DB constraint',
    );
    expect(mocks.wabotOutbound.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [{ type: 'video', url: 'https://cdn/fallback.mp4' }],
      }),
    );
  });

  it('tolerates fallback sendMessage failure when user creation fails (still rethrows original)', async () => {
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/fallback.mp4';
    const mocks = makeMocks();
    mocks.userService.find.mockResolvedValueOnce(null);
    mocks.userService.create.mockRejectedValue(new Error('DB constraint'));
    mocks.wabotOutbound.sendMessage.mockRejectedValue(new Error('wabot down'));

    await expect(runJob(makeTextJob('hi'), mocks)).rejects.toThrow(
      'DB constraint',
    );
  });

  it('tolerates createTextMedia failure but still sends welcome+referral', async () => {
    const mocks = makeMocks();
    mocks.userService.find.mockResolvedValueOnce(null);
    mocks.userService.create.mockResolvedValue({
      id: 'u-new',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.createTextMedia.mockRejectedValue(
      new Error('save failed'),
    );
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({});

    await runJob(makeTextJob('hi'), mocks);

    expect(mocks.wabotOutbound.sendMessage).toHaveBeenCalled();
  });

  it('saves audio media + rearms hail-mary for new audio user', async () => {
    const mocks = makeMocks();
    mocks.userService.find.mockResolvedValueOnce(null);
    mocks.userService.create.mockResolvedValue({
      id: 'u-new',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({});
    // No transcripts → processAnswer not called for first audio (the new-user
    // path uses userMessageId from createWhatsappAudioMedia but does not
    // require transcripts).

    const job = createAudioJob({ attemptsMade: 0 });
    await runJob(job, mocks);

    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).toHaveBeenCalled();
    // rearmHailMary is mocked at top of file; just verify the path didn't
    // throw and a send happened.
    expect(mocks.wabotOutbound.sendMessage).toHaveBeenCalled();
  });

  it('skips userMessageId-dependent lesson when first message is unsupported type (video)', async () => {
    const mocks = makeMocks();
    mocks.userService.find.mockResolvedValueOnce(null);
    mocks.userService.create.mockResolvedValue({
      id: 'u-new',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({});

    await runJob(makeVideoJob(), mocks);

    // processAnswer must NOT run — there's no user_message_id for video.
    expect(mocks.literacyLessonService.processAnswer).not.toHaveBeenCalled();
    // But the welcome+referral bundle still gets sent.
    expect(mocks.wabotOutbound.sendMessage).toHaveBeenCalled();
  });
});

describe('processWabotInboundJob — stale message guard', () => {
  afterEach(() => jest.clearAllMocks());

  it('skips messages older than 20s without sending anything', async () => {
    const mocks = makeMocks();
    const oldTs = String(Math.floor((Date.now() - 30_000) / 1000));
    const job: Job<MessageJobDto> = {
      data: {
        message: {
          from: '+910000000001',
          id: 'wamid-old',
          timestamp: oldTs,
          type: 'audio',
          audio: { url: 'https://example.com/audio' },
        },
        otel: { carrier: {} },
      } as any,
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as any;

    await runJob(job, mocks);

    expect(mocks.wabotOutbound.sendMessage).not.toHaveBeenCalled();
    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).not.toHaveBeenCalled();
  });

  it('accepts millisecond-precision timestamps (>10 digits) as already-ms', async () => {
    const mocks = makeMocks();
    // 13-digit ms timestamp from "now"
    const tsMs = String(Date.now());
    const job: Job<MessageJobDto> = {
      data: {
        message: {
          from: '+910000000001',
          id: 'wamid-ms',
          timestamp: tsMs,
          type: 'audio',
          audio: { url: 'https://example.com/audio' },
        },
        otel: { carrier: {} },
      } as any,
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as any;

    await runJob(job, mocks);
    // Not skipped → did proceed to processing
    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).toHaveBeenCalled();
  });
});

describe('processWabotInboundJob — non-audio existing-user message', () => {
  afterEach(() => jest.clearAllMocks());

  it('sends the audio-only-request prompt video when present', async () => {
    const mocks = makeMocks();
    // existing user
    mocks.userService.find.mockResolvedValue({
      id: 'u1',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({
      video: { wa_media_url: 'https://wa/audio-only.mp4', media_details: null },
    });

    await runJob(makeTextJob('hello'), mocks);

    expect(mocks.wabotOutbound.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [{ type: 'video', url: 'https://wa/audio-only.mp4' }],
      }),
    );
  });

  it('throws when the audio-only-request prompt video is missing', async () => {
    const mocks = makeMocks();
    mocks.userService.find.mockResolvedValue({
      id: 'u1',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({});

    await expect(runJob(makeTextJob('hello'), mocks)).rejects.toThrow(
      /audio-only redirect media missing/,
    );
  });
});

describe('processWabotInboundJob — audio existing-user delivery paths', () => {
  afterEach(() => jest.clearAllMocks());

  it('rolls back the user message when sendMessage 2xx returns delivered=false', async () => {
    const mocks = makeMocks();
    mocks.wabotOutbound.sendMessage.mockResolvedValue({
      status: 200,
      body: { delivered: false },
    });

    await runJob(createAudioJob(), mocks);

    expect(mocks.mediaMetaDataService.markRolledBack).toHaveBeenCalledWith(
      'audio-entity-1',
    );
  });

  it('throws "sendMessage 4XX: NNN" on a 4XX outbound response', async () => {
    const mocks = makeMocks();
    mocks.wabotOutbound.sendMessage.mockResolvedValue({
      status: 422,
      body: { delivered: false, error_code: 131000 },
    });
    await expect(runJob(createAudioJob(), mocks)).rejects.toThrow(
      'sendMessage 4XX: 422',
    );
    expect(mocks.mediaMetaDataService.markRolledBack).not.toHaveBeenCalled();
  });

  it('throws "sendMessage 5XX" on a 5XX (non-final attempt)', async () => {
    const mocks = makeMocks();
    mocks.wabotOutbound.sendMessage.mockResolvedValue({
      status: 503,
      body: { delivered: false },
    });
    await expect(
      runJob(createAudioJob({ attemptsMade: 0 }), mocks),
    ).rejects.toThrow('sendMessage 5XX: 503');
  });

  it('throws "sendMessage 5XX" on a 5XX (final attempt)', async () => {
    const mocks = makeMocks();
    mocks.wabotOutbound.sendMessage.mockResolvedValue({
      status: 502,
      body: { delivered: false },
    });
    // attemptsMade=2 + attempts=3 → 2+1>=3 → final
    await expect(
      runJob(createAudioJob({ attemptsMade: 2 }), mocks),
    ).rejects.toThrow('sendMessage 5XX: 502');
  });

  it('starts a fresh lesson when the first processAnswer returns isComplete=true', async () => {
    const mocks = makeMocks({ isComplete: true });
    await runJob(createAudioJob(), mocks);

    // First call has transcripts, second is the fresh start (no transcripts)
    expect(mocks.literacyLessonService.processAnswer).toHaveBeenCalledTimes(2);
    const firstCallArgs =
      mocks.literacyLessonService.processAnswer.mock.calls[0][0];
    const secondCallArgs =
      mocks.literacyLessonService.processAnswer.mock.calls[1][0];
    expect(firstCallArgs.transcripts).toBeDefined();
    expect(secondCallArgs.transcripts).toBeUndefined();
  });

  it('throws "No transcripts" when findTranscripts returns []', async () => {
    const mocks = makeMocks();
    mocks.mediaMetaDataService.findTranscripts.mockResolvedValue([]);
    await expect(runJob(createAudioJob(), mocks)).rejects.toThrow(
      'No transcripts',
    );
  });
});

describe('processWabotInboundJob — daily activity quota', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('does not prepend quota stid when crossedQuota is false', async () => {
    const mocks = makeMocks({ crossedQuota: false });
    await runJob(createAudioJob(), mocks);

    const stids =
      mocks.mediaMetaDataService.findMediaByStateTransitionId.mock.calls.map(
        (c: any[]) => c[0],
      );
    expect(stids).not.toContain('daily-activity-quota-reached');
    expect(stids[0]).toBe('sid-1');
  });

  it('prepends quota stid when crossedQuota is true', async () => {
    const mocks = makeMocks({ crossedQuota: true });
    await runJob(createAudioJob(), mocks);

    const stids =
      mocks.mediaMetaDataService.findMediaByStateTransitionId.mock.calls.map(
        (c: any[]) => c[0],
      );
    expect(stids[0]).toBe('daily-activity-quota-reached');
    expect(stids).toContain('sid-1');
  });

  it('calls didJustCrossDailyActivityThreshold with user id and 5min threshold', async () => {
    const mocks = makeMocks({ crossedQuota: false });
    await runJob(createAudioJob(), mocks);

    expect(
      mocks.userActivityService.didJustCrossDailyActivityThreshold,
    ).toHaveBeenCalledTimes(1);
    expect(
      mocks.userActivityService.didJustCrossDailyActivityThreshold,
    ).toHaveBeenCalledWith({ user_id: 'user-1', threshold_ms: 5 * 60 * 1000 });
  });
});
