import { Job } from 'bullmq';
import { processWabotInboundJob } from './inbound.processor';
import { MessageJobDto } from './wabot-inbound.dto';

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

function makeMocks(opts: { isComplete?: boolean } = {}) {
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

  return {
    userService,
    mediaMetaDataService,
    literacyLessonService,
    wabotOutbound,
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
