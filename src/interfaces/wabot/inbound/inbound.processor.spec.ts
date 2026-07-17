process.env.LOG_PII_HMAC_KEY = process.env.LOG_PII_HMAC_KEY ?? 'a'.repeat(64);

import { Job } from 'bullmq';
import { processWabotInboundJob } from './inbound.processor';
import { MessageJobDto } from './wabot-inbound.dto';

jest.mock('../../../notifier/hail-mary.processor', () => ({
  rearmHailMary: jest.fn().mockResolvedValue(undefined),
}));

// Span mock hoisted to module scope so tests can assert setAttribute calls
// (the span attributes are part of the observable trace contract — and many
// mutants live in the attribute keys / values / the path+outcome assignments).
const mockSpanSetAttribute = jest.fn();
const mockSpanSetStatus = jest.fn();
const mockSpanRecordException = jest.fn();
jest.mock('../../../otel/otel', () => ({
  startChildSpanWithContext: jest.fn(() => ({
    span: {
      setAttribute: mockSpanSetAttribute,
      setStatus: mockSpanSetStatus,
      recordException: mockSpanRecordException,
      end: jest.fn(),
    },
    ctx: { __ctx: true },
  })),
  // Distinct sentinels so payload otel_carrier args can be asserted exactly:
  // injectCarrier(span) carries the span; injectCarrierFromContext(ctx) the ctx.
  injectCarrier: jest.fn(() => ({ from: 'span' })),
  injectCarrierFromContext: jest.fn(() => ({ from: 'ctx' })),
}));

jest.mock('../../../otel/metrics', () => ({
  wabotInboundJobDuration: { record: jest.fn() },
  buildJobAttributes: (outcome: string) => ({ outcome, load_test: 'false' }),
}));

jest.mock('../../../otel/baggage-keys', () => ({
  BAGGAGE_LOAD_TEST: 'padhaipal.load_test',
  BAGGAGE_TEST_PHASE: 'padhaipal.test_phase',
  PROPAGATED_BAGGAGE_KEYS: ['padhaipal.load_test', 'padhaipal.test_phase'],
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
  opts: {
    isComplete?: boolean;
    activeTime?: { withLatestTurn: number; withoutLatestTurn: number };
  } = {},
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
    getTodayActiveTime: jest
      .fn()
      .mockResolvedValue(
        opts.activeTime ?? { withLatestTurn: 0, withoutLatestTurn: 0 },
      ),
  };
  const outboundMessages = {
    recordSent: jest.fn().mockResolvedValue(undefined),
  };

  return {
    userService,
    mediaMetaDataService,
    literacyLessonService,
    wabotOutbound,
    userActivityService,
    outboundMessages,
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
    mocks.outboundMessages as any,
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

function makeTextJob(
  body: string,
  opts: { consecutive?: boolean } = {},
): Job<MessageJobDto> {
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
      ...(opts.consecutive !== undefined
        ? { consecutive: opts.consecutive }
        : {}),
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
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );

    await runJob(makeTextJob('hello world'), mocks);

    expect(mocks.userService.create).toHaveBeenCalledWith({
      external_id: '+910000000001',
      referrer_external_id: undefined,
    });
    expect(mocks.wabotOutbound.sendMessage).toHaveBeenCalled();
    // referral link must be present
    const media = (
      mocks.wabotOutbound.sendMessage.mock.calls[0][0] as {
        media: { type: string; body?: string }[];
      }
    ).media;
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
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );

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
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );

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
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );

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
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );
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
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );

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
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );

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

describe('processWabotInboundJob — active-minute milestones', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const MIN = 60_000;

  // stids passed to findMediaByStateTransitionId, in call order.
  function calledStids(mocks: ReturnType<typeof makeMocks>): string[] {
    return mocks.mediaMetaDataService.findMediaByStateTransitionId.mock.calls.map(
      (c: any[]) => c[0],
    );
  }

  it('does not prepend a milestone stid when no threshold is crossed', async () => {
    const mocks = makeMocks({
      activeTime: { withLatestTurn: 4 * MIN, withoutLatestTurn: 3 * MIN },
    });
    await runJob(createAudioJob(), mocks);

    const stids = calledStids(mocks);
    expect(stids).toEqual(['sid-1']);
  });

  it('prepends the 5-minute stid when the latest turn crosses 5 minutes', async () => {
    const mocks = makeMocks({
      activeTime: {
        withLatestTurn: 5 * MIN + 1_000,
        withoutLatestTurn: 5 * MIN - 1_000,
      },
    });
    await runJob(createAudioJob(), mocks);

    const stids = calledStids(mocks);
    expect(stids[0]).toBe('threshold-reached-5-active-minutes-today');
    expect(stids).toContain('sid-1');
  });

  it('fires when withLatestTurn lands EXACTLY on the threshold (>= not >)', async () => {
    const mocks = makeMocks({
      activeTime: { withLatestTurn: 5 * MIN, withoutLatestTurn: 5 * MIN - 1 },
    });
    await runJob(createAudioJob(), mocks);

    expect(calledStids(mocks)[0]).toBe(
      'threshold-reached-5-active-minutes-today',
    );
  });

  it('does NOT re-fire on the next turn when withoutLatestTurn EXACTLY equals the threshold (< not <=)', async () => {
    const mocks = makeMocks({
      activeTime: {
        withLatestTurn: 5 * MIN + 30_000,
        withoutLatestTurn: 5 * MIN,
      },
    });
    await runJob(createAudioJob(), mocks);

    expect(calledStids(mocks)).toEqual(['sid-1']);
  });

  it('emits the matching stid for a mid-list threshold (10 minutes)', async () => {
    const mocks = makeMocks({
      activeTime: {
        withLatestTurn: 10 * MIN + 500,
        withoutLatestTurn: 10 * MIN - 500,
      },
    });
    await runJob(createAudioJob(), mocks);

    expect(calledStids(mocks)[0]).toBe(
      'threshold-reached-10-active-minutes-today',
    );
  });

  it('emits the matching stid for the highest threshold (60 minutes)', async () => {
    const mocks = makeMocks({
      activeTime: {
        withLatestTurn: 60 * MIN + 500,
        withoutLatestTurn: 60 * MIN - 500,
      },
    });
    await runJob(createAudioJob(), mocks);

    expect(calledStids(mocks)[0]).toBe(
      'threshold-reached-60-active-minutes-today',
    );
  });

  it('emits at most ONE milestone even if the values straddle several thresholds (break after first match)', async () => {
    // Cannot happen in production (a turn adds <60s of active time) but the
    // loop must still be safe: only the lowest crossed threshold fires.
    const mocks = makeMocks({
      activeTime: { withLatestTurn: 21 * MIN, withoutLatestTurn: 1 * MIN },
    });
    await runJob(createAudioJob(), mocks);

    const stids = calledStids(mocks);
    expect(stids[0]).toBe('threshold-reached-5-active-minutes-today');
    expect(stids).toEqual([
      'threshold-reached-5-active-minutes-today',
      'sid-1',
    ]);
  });

  it('calls getTodayActiveTime exactly once with the resolved user id', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob(), mocks);

    expect(mocks.userActivityService.getTodayActiveTime).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.userActivityService.getTodayActiveTime).toHaveBeenCalledWith(
      'user-1',
    );
  });
});

// ─── mutation hardening ──────────────────────────────────────────────────────
// Tightens assertions so Stryker mutants in this processor are killed:
//   - exact `toHaveBeenCalledWith` args (kills ObjectLiteral `{}` mutants)
//   - span.setAttribute key/value + path/outcome (kills string + boolean mutants)
//   - timestamp ms/sec and 20s-staleness boundaries (kills equality mutants)
//   - referrer-from-text regex / self-exclusion / first-match (kills regex +
//     conditional mutants)
//   - logged messages (kills the log-template StringLiteral mutants)
import { Logger } from '@nestjs/common';

describe('processWabotInboundJob — exact downstream call args (audio reply)', () => {
  afterEach(() => jest.clearAllMocks());

  it('passes the exact wa_media_url + resolved user + span carrier to createWhatsappAudioMedia', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob(), mocks);
    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).toHaveBeenCalledWith({
      wa_media_url: 'https://example.com/audio',
      user: { id: 'user-1', external_id: '+910000000001' },
      otel_carrier: { from: 'span' },
    });
  });

  it('re-arms hail-mary with the exact user + audio-entity id + span carrier', async () => {
    const { rearmHailMary } = jest.requireMock(
      '../../../notifier/hail-mary.processor',
    );
    const mocks = makeMocks();
    await runJob(createAudioJob(), mocks);
    expect(rearmHailMary).toHaveBeenCalledWith({
      user_id: 'user-1',
      user_external_id: '+910000000001',
      user_message_id: 'audio-entity-1',
      otel_carrier: { from: 'span' },
    });
  });

  it('calls processAnswer with the resolved user, the transcripts, and the audio-entity id', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob(), mocks);
    expect(mocks.literacyLessonService.processAnswer).toHaveBeenCalledWith({
      user: { id: 'user-1', external_id: '+910000000001' },
      transcripts: [{ text: 'ओम' }],
      user_message_id: 'audio-entity-1',
    });
  });

  it('finds transcripts for the exact audio entity', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob(), mocks);
    expect(mocks.mediaMetaDataService.findTranscripts).toHaveBeenCalledWith({
      media_metadata: { id: 'audio-entity-1' },
    });
  });

  it('sends the outbound message with exact external_id, wamid, and the ctx carrier', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob(), mocks);
    const arg = mocks.wabotOutbound.sendMessage.mock.calls[0][0];
    expect(arg.user_external_id).toBe('+910000000001');
    expect(arg.wamid).toBe('wamid-test-1');
    expect(arg.otel_carrier).toEqual({ from: 'ctx' });
    expect(Array.isArray(arg.media)).toBe(true);
  });

  it('resolves the user by external_id (exact lookup args)', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob(), mocks);
    expect(mocks.userService.find).toHaveBeenCalledWith({
      external_id: '+910000000001',
    });
  });
});

describe('processWabotInboundJob — span attributes', () => {
  afterEach(() => jest.clearAllMocks());

  it('tags wamid, message type, consecutive=false, and pp.path/pp.outcome on the audio path', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob(), mocks);
    const calls = mockSpanSetAttribute.mock.calls;
    expect(calls).toContainEqual(['wabot.wamid', 'wamid-test-1']);
    expect(calls).toContainEqual(['wabot.message.type', 'audio']);
    expect(calls).toContainEqual(['wabot.consecutive', false]);
    expect(calls).toContainEqual(['pp.path', 'audio-reply']);
    expect(calls).toContainEqual(['pp.outcome', 'success']);
  });

  it('records consecutive=true when the message is flagged consecutive', async () => {
    const mocks = makeMocks();
    const job = createAudioJob();
    (job.data as { consecutive?: boolean }).consecutive = true;
    await runJob(job, mocks);
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'wabot.consecutive',
      true,
    ]);
    // consecutive short-circuits → skipped outcome, consecutive-skip path.
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.path',
      'consecutive-skip',
    ]);
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.outcome',
      'skipped',
    ]);
  });

  it('tags pp.path=system + pp.outcome=success on a phone-change message', async () => {
    const mocks = makeMocks();
    mocks.userService.update.mockResolvedValue({
      id: 'u1',
      external_id: '+910000000002',
    });
    await runJob(makeSystemJob(), mocks);
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.path',
      'system',
    ]);
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.outcome',
      'success',
    ]);
  });

  it('tags pp.outcome=error when the job throws (no-transcripts path)', async () => {
    const mocks = makeMocks();
    mocks.mediaMetaDataService.findTranscripts.mockResolvedValue([]);
    await expect(runJob(createAudioJob(), mocks)).rejects.toThrow();
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.outcome',
      'error',
    ]);
    // path was set to 'audio-reply' before the throw.
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.path',
      'audio-reply',
    ]);
  });

  it('tags pp.path=stale-skip + pp.outcome=skipped for an old message', async () => {
    const mocks = makeMocks();
    const job = createAudioJob();
    job.data.message.timestamp = String(Math.floor(Date.now() / 1000) - 60);
    await runJob(job, mocks);
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.path',
      'stale-skip',
    ]);
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.outcome',
      'skipped',
    ]);
  });

  it('tags pp.path=non-audio-redirect on a fresh-but-existing-user text message', async () => {
    const mocks = makeMocks();
    // existing user (find returns user), text type → audio-only redirect.
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({
      video: { wa_media_url: 'https://wa/audio-only.mp4', media_details: null },
    });
    await runJob(makeTextJob('hello'), mocks);
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.path',
      'non-audio-redirect',
    ]);
  });
});

describe('processWabotInboundJob — timestamp boundaries', () => {
  afterEach(() => jest.clearAllMocks());

  function audioJobAtTimestamp(ts: string): Job<MessageJobDto> {
    const job = createAudioJob();
    job.data.message.timestamp = ts;
    return job;
  }

  it('treats a 10-digit (seconds) timestamp of "now" as fresh (× 1000)', async () => {
    const mocks = makeMocks();
    const nowSec = Math.floor(Date.now() / 1000); // ≤ 9_999_999_999 → seconds
    await runJob(audioJobAtTimestamp(String(nowSec)), mocks);
    // Fresh → proceeds to process (not stale-skip).
    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).toHaveBeenCalled();
  });

  it('treats a 13-digit (millisecond) timestamp of "now" as already-ms (no × 1000)', async () => {
    const mocks = makeMocks();
    const nowMs = Date.now(); // > 9_999_999_999 → already ms
    await runJob(audioJobAtTimestamp(String(nowMs)), mocks);
    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).toHaveBeenCalled();
  });

  it('a seconds timestamp 25s in the past is stale (kills the >20000 / >=20000 boundary)', async () => {
    const mocks = makeMocks();
    const ts = String(Math.floor(Date.now() / 1000) - 25);
    await runJob(audioJobAtTimestamp(ts), mocks);
    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).not.toHaveBeenCalled();
  });

  it('a seconds timestamp ~5s in the past is fresh (well under 20s)', async () => {
    const mocks = makeMocks();
    const ts = String(Math.floor(Date.now() / 1000) - 5);
    await runJob(audioJobAtTimestamp(ts), mocks);
    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).toHaveBeenCalled();
  });
});

describe('processWabotInboundJob — referrer extraction (new user, from text)', () => {
  afterEach(() => jest.clearAllMocks());

  function newUserText(body: string) {
    const mocks = makeMocks();
    // 1st find = self (miss), 2nd find = referrer lookup.
    mocks.userService.find.mockReset();
    mocks.userService.create.mockResolvedValue({
      id: 'u-new',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.createTextMedia.mockResolvedValue({ id: 't1' });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );
    return { mocks, job: makeTextJob(body) };
  }

  it('extracts a 10-digit referrer number from the text and looks it up', async () => {
    const { mocks, job } = newUserText('मेरा रेफरल 9876543210 है');
    mocks.userService.find
      .mockResolvedValueOnce(null) // self
      .mockResolvedValueOnce({ id: 'ref-1', external_id: '+919876543210' }); // referrer
    await runJob(job, mocks);
    expect(mocks.userService.create).toHaveBeenCalledWith({
      external_id: '+910000000001',
      referrer_external_id: '+919876543210',
    });
  });

  it('does NOT treat a short (<7 digit) number as a referrer (kills the \\d{7,} regex mutant)', async () => {
    const { mocks, job } = newUserText('code 123456'); // only 6 digits
    mocks.userService.find.mockResolvedValue(null);
    await runJob(job, mocks);
    expect(mocks.userService.create).toHaveBeenCalledWith({
      external_id: '+910000000001',
      referrer_external_id: undefined,
    });
  });

  it("excludes the sender's own number from being used as a referrer", async () => {
    // The sender is +910000000001 → digits 910000000001 in the text must be
    // rejected by the `format(E.164) !== from` self-exclusion guard.
    const { mocks, job } = newUserText('this is my own number 910000000001');
    mocks.userService.find.mockResolvedValue(null);
    await runJob(job, mocks);
    expect(mocks.userService.create).toHaveBeenCalledWith({
      external_id: '+910000000001',
      referrer_external_id: undefined,
    });
  });

  it('falls back to no referrer when the parsed referrer is not in the DB', async () => {
    const { mocks, job } = newUserText('ref 9876543210');
    mocks.userService.find
      .mockResolvedValueOnce(null) // self
      .mockResolvedValueOnce(null); // referrer not found
    await runJob(job, mocks);
    expect(mocks.userService.create).toHaveBeenCalledWith({
      external_id: '+910000000001',
      referrer_external_id: undefined,
    });
  });
});

describe('processWabotInboundJob — logged messages', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.clearAllMocks();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  function loggedMessages(spy: jest.SpyInstance): string {
    return spy.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('logs the phone-change with both hashed numbers', async () => {
    const mocks = makeMocks();
    mocks.userService.update.mockResolvedValue({
      id: 'u1',
      external_id: '+910000000002',
    });
    await runJob(makeSystemJob(), mocks);
    expect(loggedMessages(logSpy)).toMatch(/Updated user phone/);
  });

  it('logs an error when the phone-change user is not found', async () => {
    const mocks = makeMocks();
    mocks.userService.update.mockResolvedValue(null);
    await expect(runJob(makeSystemJob(), mocks)).rejects.toThrow();
    expect(loggedMessages(errorSpy)).toMatch(/user not found for old phone/i);
  });

  it('logs the consecutive-skip message', async () => {
    const mocks = makeMocks();
    await runJob(makeTextJob('hi', { consecutive: true }), mocks);
    expect(loggedMessages(logSpy)).toMatch(/Ignoring consecutive message/);
  });

  it('logs the stale-skip message for an old message', async () => {
    const mocks = makeMocks();
    const job = createAudioJob();
    job.data.message.timestamp = String(Math.floor(Date.now() / 1000) - 60);
    await runJob(job, mocks);
    expect(loggedMessages(warnSpy)).toMatch(/older than 20s/);
  });

  it('logs an error and throws when the audio-only redirect media is missing', async () => {
    const mocks = makeMocks();
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    ); // no .video
    await expect(runJob(makeTextJob('hello'), mocks)).rejects.toThrow(
      /audio-only redirect media missing/,
    );
    expect(loggedMessages(errorSpy)).toMatch(/Missing media for/);
  });

  it('logs "No transcripts found" before throwing', async () => {
    const mocks = makeMocks();
    mocks.mediaMetaDataService.findTranscripts.mockResolvedValue([]);
    await expect(runJob(createAudioJob(), mocks)).rejects.toThrow();
    expect(loggedMessages(errorSpy)).toMatch(/No transcripts found/);
  });

  it('logs delivery success for the audio reply', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob(), mocks);
    expect(loggedMessages(logSpy)).toMatch(/Message delivered/);
  });
});

describe('processWabotInboundJob — outbound delivery branches (audio reply)', () => {
  afterEach(() => jest.clearAllMocks());

  it('rolls back the user message when the send is accepted but not delivered', async () => {
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

  it('does NOT roll back when delivered=true', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob(), mocks);
    expect(mocks.mediaMetaDataService.markRolledBack).not.toHaveBeenCalled();
  });

  it('throws on a 4XX send response (kills the 400-range conditional)', async () => {
    const mocks = makeMocks();
    mocks.wabotOutbound.sendMessage.mockResolvedValue({
      status: 422,
      body: { delivered: false },
    });
    await expect(runJob(createAudioJob(), mocks)).rejects.toThrow(
      /sendMessage 4XX: 422/,
    );
    expect(mocks.mediaMetaDataService.markRolledBack).not.toHaveBeenCalled();
  });

  it('throws on a 5XX send response (final attempt)', async () => {
    const mocks = makeMocks();
    mocks.wabotOutbound.sendMessage.mockResolvedValue({
      status: 503,
      body: { delivered: false },
    });
    await expect(
      runJob(createAudioJob({ attemptsMade: 2 }), mocks),
    ).rejects.toThrow(/sendMessage 5XX: 503/);
  });
});

// ─── mutation hardening, batch 2 ─────────────────────────────────────────────

describe('processWabotInboundJob — span/start identifiers', () => {
  afterEach(() => jest.clearAllMocks());

  it('starts the child span named "wabot-inbound-processor" with the incoming carrier', async () => {
    const { startChildSpanWithContext } =
      jest.requireMock('../../../otel/otel');
    const mocks = makeMocks();
    const job = createAudioJob();
    (job.data as { otel: { carrier: unknown } }).otel = {
      carrier: { traceparent: 'tp-in' },
    };
    await runJob(job, mocks);
    expect(startChildSpanWithContext).toHaveBeenCalledWith(
      'wabot-inbound-processor',
      { traceparent: 'tp-in' },
    );
  });

  it('tags the hashed external_id under the wabot.user.external_id_hash key', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob(), mocks);
    const keys = mockSpanSetAttribute.mock.calls.map((c) => c[0]);
    expect(keys).toContain('wabot.user.external_id_hash');
  });
});

describe('processWabotInboundJob — outbound media assembly (appendMediaItems)', () => {
  afterEach(() => jest.clearAllMocks());

  it('maps each media type from the lesson result into the outbound payload', async () => {
    const mocks = makeMocks();
    // Single stid → media with a video + a text entity.
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({
      video: {
        wa_media_url: 'https://wa/v.mp4',
        media_details: { mime_type: 'video/mp4' },
      },
      text: { text: 'शाबाश' },
    });
    await runJob(createAudioJob(), mocks);

    const media = mocks.wabotOutbound.sendMessage.mock.calls[0][0].media as {
      type: string;
      url?: string;
      body?: string;
      mime_type?: string;
    }[];
    expect(media).toContainEqual({
      type: 'video',
      url: 'https://wa/v.mp4',
      mime_type: 'video/mp4',
    });
    expect(media).toContainEqual({ type: 'text', body: 'शाबाश' });
  });

  it('emits a media item with undefined mime_type when media_details is null', async () => {
    const mocks = makeMocks();
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({
      image: { wa_media_url: 'https://wa/i.png', media_details: null },
    });
    await runJob(createAudioJob(), mocks);
    const media = mocks.wabotOutbound.sendMessage.mock.calls[0][0].media as {
      type: string;
      url?: string;
      mime_type?: string;
    }[];
    expect(media).toContainEqual({
      type: 'image',
      url: 'https://wa/i.png',
      mime_type: undefined,
    });
  });
});

describe('processWabotInboundJob — send-status boundaries (audio reply)', () => {
  afterEach(() => jest.clearAllMocks());

  function sendStatus(status: number, delivered = false) {
    const mocks = makeMocks();
    mocks.wabotOutbound.sendMessage.mockResolvedValue({
      status,
      body: { delivered },
    });
    return mocks;
  }

  it('200 delivered → success, no rollback', async () => {
    const mocks = sendStatus(200, true);
    await runJob(createAudioJob(), mocks);
    expect(mocks.mediaMetaDataService.markRolledBack).not.toHaveBeenCalled();
  });

  it('299 delivered=false → treated as 2xx → rolls back (kills the <300 → <=300 boundary)', async () => {
    const mocks = sendStatus(299, false);
    await runJob(createAudioJob(), mocks);
    expect(mocks.mediaMetaDataService.markRolledBack).toHaveBeenCalledWith(
      'audio-entity-1',
    );
  });

  it('300 → NOT 2xx → falls through to the 5XX throw (kills <300 → <=300)', async () => {
    const mocks = sendStatus(300, true);
    await expect(runJob(createAudioJob(), mocks)).rejects.toThrow(
      /sendMessage 5XX: 300/,
    );
    expect(mocks.mediaMetaDataService.markRolledBack).not.toHaveBeenCalled();
  });

  it('400 → 4XX throw (lower boundary of the 400-range)', async () => {
    const mocks = sendStatus(400);
    await expect(runJob(createAudioJob(), mocks)).rejects.toThrow(
      /sendMessage 4XX: 400/,
    );
  });

  it('499 → 4XX throw (upper boundary of the 400-range)', async () => {
    const mocks = sendStatus(499);
    await expect(runJob(createAudioJob(), mocks)).rejects.toThrow(
      /sendMessage 4XX: 499/,
    );
  });

  it('500 → 5XX throw (kills the <500 upper-bound of the 4XX range)', async () => {
    const mocks = sendStatus(500);
    await expect(runJob(createAudioJob(), mocks)).rejects.toThrow(
      /sendMessage 5XX: 500/,
    );
  });

  it('5XX on a non-final attempt still throws (warn branch)', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const mocks = sendStatus(503);
    await expect(
      runJob(createAudioJob({ attemptsMade: 0 }), mocks),
    ).rejects.toThrow(/sendMessage 5XX: 503/);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /sendMessage 5XX \(attempt 1\)/,
    );
    warnSpy.mockRestore();
  });
});

describe('processWabotInboundJob — exact boundary timestamps', () => {
  afterEach(() => jest.clearAllMocks());

  it('timestamp exactly 9_999_999_999 is treated as SECONDS (× 1000 → future → fresh)', async () => {
    // 9_999_999_999 is the inclusive boundary: <= keeps it in the seconds
    // branch (×1000 → year 2286 → not stale). The `<` mutant would treat it
    // as ms (no ×1000 → ancient → stale-skip).
    const mocks = makeMocks();
    const job = createAudioJob();
    job.data.message.timestamp = '9999999999';
    await runJob(job, mocks);
    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).toHaveBeenCalled();
  });

  it('a message exactly 20_000 ms old is NOT stale (kills the >20000 → >=20000 boundary)', async () => {
    const mocks = makeMocks();
    const T = 1_900_000_000_000; // fixed "now" in ms
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T);
    const job = createAudioJob();
    // 13-digit ms timestamp exactly 20s before "now": Date.now()-tsMs === 20000.
    job.data.message.timestamp = String(T - 20_000);
    await runJob(job, mocks);
    // `> 20000` is false at exactly 20000 → message processed (not skipped).
    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it('a message 20_001 ms old IS stale', async () => {
    const mocks = makeMocks();
    const T = 1_900_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T);
    const job = createAudioJob();
    job.data.message.timestamp = String(T - 20_001);
    await runJob(job, mocks);
    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});

describe('processWabotInboundJob — complete-restart second lesson', () => {
  afterEach(() => jest.clearAllMocks());

  it('on isComplete, calls processAnswer a second time with the same user + message but no transcripts', async () => {
    const mocks = makeMocks({ isComplete: true });
    await runJob(createAudioJob(), mocks);
    expect(mocks.literacyLessonService.processAnswer).toHaveBeenCalledTimes(2);
    expect(mocks.literacyLessonService.processAnswer).toHaveBeenNthCalledWith(
      2,
      {
        user: { id: 'user-1', external_id: '+910000000001' },
        user_message_id: 'audio-entity-1',
      },
    );
  });
});

describe('processWabotInboundJob — new-user exact downstream args', () => {
  afterEach(() => jest.clearAllMocks());

  function newUserAudio() {
    const mocks = makeMocks();
    mocks.userService.find.mockReset();
    mocks.userService.find.mockResolvedValue(null); // brand-new user
    mocks.userService.create.mockResolvedValue({
      id: 'u-new',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );
    return mocks;
  }

  it('saves a new TEXT user message with the exact body + resolved user', async () => {
    const mocks = makeMocks();
    mocks.userService.find.mockReset();
    mocks.userService.find.mockResolvedValue(null);
    mocks.userService.create.mockResolvedValue({
      id: 'u-new',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.createTextMedia.mockResolvedValue({ id: 't1' });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );
    await runJob(makeTextJob('नमस्ते'), mocks);
    expect(mocks.mediaMetaDataService.createTextMedia).toHaveBeenCalledWith({
      text: 'नमस्ते',
      user: { id: 'u-new', external_id: '+910000000001' },
    });
  });

  it('saves a new AUDIO user message + re-arms hail-mary with the span carrier', async () => {
    const { rearmHailMary } = jest.requireMock(
      '../../../notifier/hail-mary.processor',
    );
    const mocks = newUserAudio();
    mocks.mediaMetaDataService.createWhatsappAudioMedia.mockResolvedValue({
      id: 'audio-new',
    });
    await runJob(createAudioJob(), mocks);
    expect(
      mocks.mediaMetaDataService.createWhatsappAudioMedia,
    ).toHaveBeenCalledWith({
      wa_media_url: 'https://example.com/audio',
      user: { id: 'u-new', external_id: '+910000000001' },
      otel_carrier: { from: 'span' },
    });
    expect(rearmHailMary).toHaveBeenCalledWith({
      user_id: 'u-new',
      user_external_id: '+910000000001',
      user_message_id: 'audio-new',
      otel_carrier: { from: 'span' },
    });
  });

  it("starts the new user's first lesson with their user_message_id", async () => {
    const mocks = newUserAudio();
    mocks.mediaMetaDataService.createWhatsappAudioMedia.mockResolvedValue({
      id: 'audio-new',
    });
    await runJob(createAudioJob(), mocks);
    expect(mocks.literacyLessonService.processAnswer).toHaveBeenCalledWith({
      user: { id: 'u-new', external_id: '+910000000001' },
      user_message_id: 'audio-new',
    });
  });

  it('sends the onboarding bundle with the ctx carrier', async () => {
    const mocks = newUserAudio();
    mocks.mediaMetaDataService.createWhatsappAudioMedia.mockResolvedValue({
      id: 'audio-new',
    });
    await runJob(createAudioJob(), mocks);
    const arg = mocks.wabotOutbound.sendMessage.mock.calls[0][0];
    expect(arg.user_external_id).toBe('+910000000001');
    expect(arg.otel_carrier).toEqual({ from: 'ctx' });
  });
});

describe('processWabotInboundJob — failure tolerance (no-coverage catch blocks)', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.clearAllMocks();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
  const warned = () => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');

  function newUser() {
    const mocks = makeMocks();
    mocks.userService.find.mockReset();
    mocks.userService.find.mockResolvedValue(null);
    mocks.userService.create.mockResolvedValue({
      id: 'u-new',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );
    return mocks;
  }

  it('tolerates rearmHailMary throwing for a NEW audio user (logs, still sends onboarding)', async () => {
    const { rearmHailMary } = jest.requireMock(
      '../../../notifier/hail-mary.processor',
    );
    rearmHailMary.mockRejectedValueOnce(new Error('queue down'));
    const mocks = newUser();
    mocks.mediaMetaDataService.createWhatsappAudioMedia.mockResolvedValue({
      id: 'audio-new',
    });
    await runJob(createAudioJob(), mocks);
    expect(warned()).toMatch(/rearmHailMary failed for new user/);
    expect(mocks.wabotOutbound.sendMessage).toHaveBeenCalled(); // still onboards
  });

  it('tolerates the welcome-media lookup throwing (logs, continues onboarding)', async () => {
    const mocks = newUser();
    mocks.mediaMetaDataService.createTextMedia.mockResolvedValue({ id: 't1' });
    // First findMediaByStateTransitionId call (welcome) throws; later calls ok.
    mocks.mediaMetaDataService.findMediaByStateTransitionId
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({});
    await runJob(makeTextJob('hi'), mocks);
    expect(warned()).toMatch(/Failed to fetch welcome media/);
    expect(mocks.wabotOutbound.sendMessage).toHaveBeenCalled();
  });

  it('tolerates the new-user first lesson throwing (logs, still sends what it has)', async () => {
    const mocks = newUser();
    mocks.mediaMetaDataService.createTextMedia.mockResolvedValue({ id: 't1' });
    mocks.literacyLessonService.processAnswer.mockRejectedValue(
      new Error('lesson boom'),
    );
    await runJob(makeTextJob('hi'), mocks);
    expect(warned()).toMatch(/Failed to start first lesson for new user/);
  });

  it('tolerates the onboarding send throwing (logs, does not fail the job)', async () => {
    const mocks = newUser();
    mocks.mediaMetaDataService.createTextMedia.mockResolvedValue({ id: 't1' });
    mocks.wabotOutbound.sendMessage.mockRejectedValue(new Error('wabot down'));
    await expect(runJob(makeTextJob('hi'), mocks)).resolves.toBeUndefined();
    expect(warned()).toMatch(/Failed to send new-user onboarding/);
  });

  it('skips the new-user first lesson when no user_message_id was produced (unsupported type)', async () => {
    const mocks = newUser();
    // Video type for a new user → no text/audio entity → userMessageId undefined.
    await runJob(makeVideoJob(), mocks);
    expect(warned()).toMatch(/New-user first lesson skipped/);
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /sent unsupported type/,
    );
  });

  it('logs and falls back when a referrer is parsed but not found in the DB', async () => {
    const mocks = makeMocks();
    mocks.userService.find.mockReset();
    mocks.userService.find
      .mockResolvedValueOnce(null) // self
      .mockResolvedValueOnce(null); // referrer not found
    mocks.userService.create.mockResolvedValue({
      id: 'u-new',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.createTextMedia.mockResolvedValue({ id: 't1' });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );
    await runJob(makeTextJob('ref 9876543210'), mocks);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /Referrer .* not found/,
    );
  });

  it('on user-create failure: sends the fallback video and logs, then rethrows', async () => {
    const mocks = makeMocks();
    mocks.userService.find.mockReset();
    mocks.userService.find.mockResolvedValue(null);
    mocks.userService.create.mockRejectedValue(new Error('dup key'));
    await expect(runJob(makeTextJob('hi'), mocks)).rejects.toThrow('dup key');
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /Failed to create user/,
    );
    // Fallback video send attempted.
    expect(mocks.wabotOutbound.sendMessage).toHaveBeenCalled();
  });
});

describe('processWabotInboundJob — handleSendResult logging (onboarding + audio-only)', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.clearAllMocks();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function existingUserAudioOnly() {
    const mocks = makeMocks();
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({
      video: { wa_media_url: 'https://wa/audio-only.mp4', media_details: null },
    });
    return mocks;
  }

  it('logs a 4XX from the audio-only redirect send without throwing', async () => {
    const mocks = existingUserAudioOnly();
    mocks.wabotOutbound.sendMessage.mockResolvedValue({
      status: 422,
      body: {},
    });
    await runJob(makeTextJob('hello'), mocks);
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /audio-only sendMessage 4XX: 422/,
    );
  });

  it('logs a 5XX from the audio-only redirect send without throwing', async () => {
    const mocks = existingUserAudioOnly();
    mocks.wabotOutbound.sendMessage.mockResolvedValue({
      status: 503,
      body: {},
    });
    await runJob(makeTextJob('hello'), mocks);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /audio-only sendMessage 5XX: 503/,
    );
  });

  it('logs a 4XX from the new-user onboarding send under the new-user-onboarding label', async () => {
    const mocks = makeMocks();
    mocks.userService.find.mockReset();
    mocks.userService.find.mockResolvedValue(null);
    mocks.userService.create.mockResolvedValue({
      id: 'u-new',
      external_id: '+910000000001',
    });
    mocks.mediaMetaDataService.createTextMedia.mockResolvedValue({ id: 't1' });
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue(
      {},
    );
    mocks.wabotOutbound.sendMessage.mockResolvedValue({
      status: 422,
      body: {},
    });
    await runJob(makeTextJob('hi'), mocks);
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /new-user-onboarding sendMessage 4XX: 422/,
    );
  });
});

describe('processWabotInboundJob — sentence text rendering', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('appends the runtime-generated sentence as a trailing text message', async () => {
    const mocks = makeMocks();
    mocks.literacyLessonService.processAnswer.mockResolvedValue({
      stateTransitionIds: ['sentence-start-sentence-initial'],
      isComplete: false,
      sentenceText: 'नल घर कमल',
    });
    await runJob(createAudioJob(), mocks);
    const media = mocks.wabotOutbound.sendMessage.mock.calls[0][0].media;
    expect(media[media.length - 1]).toEqual({
      type: 'text',
      body: 'नल घर कमल',
    });
  });

  it('uses the fresh lesson’s sentenceText when the first lesson completes', async () => {
    const mocks = makeMocks();
    mocks.literacyLessonService.processAnswer
      .mockResolvedValueOnce({
        stateTransitionIds: ['कमल-word-complete-correct-first'],
        isComplete: true,
      })
      .mockResolvedValueOnce({
        stateTransitionIds: ['sentence-start-sentence-initial'],
        isComplete: false,
        sentenceText: 'अब सूरज',
      });
    await runJob(createAudioJob(), mocks);
    const media = mocks.wabotOutbound.sendMessage.mock.calls[0][0].media;
    expect(media[media.length - 1]).toEqual({
      type: 'text',
      body: 'अब सूरज',
    });
  });

  it('appends no text message when no sentence is in play', async () => {
    const mocks = makeMocks();
    await runJob(createAudioJob(), mocks);
    const media = mocks.wabotOutbound.sendMessage.mock.calls[0][0].media;
    expect(
      media.filter((m: { type: string }) => m.type === 'text'),
    ).toHaveLength(0);
  });
});

describe('processWabotInboundJob — outbound_messages audit recording', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('records entity-backed items with trigger inbound-reply after a 2xx send', async () => {
    const mocks = makeMocks();
    mocks.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({
      audio: { id: 'media-a', wa_media_url: 'https://a', media_details: null },
    });
    await runJob(createAudioJob(), mocks);
    expect(mocks.outboundMessages.recordSent).toHaveBeenCalledWith({
      user_id: 'user-1',
      user_message_id: 'audio-entity-1',
      trigger: 'inbound-reply',
      items: [{ media_metadata_id: 'media-a', state_transition_id: 'sid-1' }],
    });
  });

  it('does NOT record when wabot rejects the send (4xx)', async () => {
    const mocks = makeMocks();
    mocks.wabotOutbound.sendMessage.mockResolvedValue({
      status: 400,
      body: { delivered: false, reason: 'whatsapp-error' },
    });
    await expect(runJob(createAudioJob(), mocks)).rejects.toThrow(
      'sendMessage 4XX',
    );
    expect(mocks.outboundMessages.recordSent).not.toHaveBeenCalled();
  });

  it('records BEFORE the rolled-back branch so flips can find the rows', async () => {
    const order: string[] = [];
    const mocks = makeMocks();
    mocks.outboundMessages.recordSent.mockImplementation(async () => {
      order.push('record');
    });
    mocks.mediaMetaDataService.markRolledBack.mockImplementation(async () => {
      order.push('rollback');
    });
    mocks.wabotOutbound.sendMessage.mockResolvedValue({
      status: 200,
      body: { delivered: false, reason: 'inflight-expired' },
    });
    await runJob(createAudioJob(), mocks);
    expect(order).toEqual(['record', 'rollback']);
  });
});
