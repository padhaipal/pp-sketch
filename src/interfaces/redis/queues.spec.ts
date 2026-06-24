// The queues module opens a real Redis socket at module load. Mock ioredis
// + bullmq so importing this file is harmless and we can capture the args
// every Queue/Worker is constructed with.

const mockRedisInstance = { quit: jest.fn().mockResolvedValue('OK') };
const mockRedisCtor = jest.fn();
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation((...args: unknown[]) => {
    mockRedisCtor(...args);
    return mockRedisInstance;
  });
});

const mockQueueCtor = jest.fn();
const mockWorkerCtor = jest.fn();
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((...args: unknown[]) => {
    mockQueueCtor(...args);
    // .on is needed for the queue-metrics depth-gauge callback's
    // getJobCounts call to be invokable; we return a no-op queue stub.
    return {
      __kind: 'Queue',
      args,
      getJobCounts: jest.fn().mockResolvedValue({}),
    };
  }),
  Worker: jest.fn().mockImplementation((...args: unknown[]) => {
    mockWorkerCtor(...args);
    // .on is needed because queue-metrics.instrumentWorker subscribes
    // to 'completed' / 'failed' / 'stalled' events.
    return { __kind: 'Worker', args, on: jest.fn() };
  }),
}));

// Mock queue-metrics so that wiring it in doesn't require the OTel meter
// to be set up at module load.
jest.mock('../../otel/queue-metrics', () => ({
  instrumentQueue: jest.fn(),
  instrumentWorker: jest.fn(),
}));

process.env.BULLMQ_REDIS_URL = 'redis://test-bullmq:6379';

import {
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  createQueue,
  createWorker,
  queueRedisConnection,
} from './queues';

beforeEach(() => {
  mockQueueCtor.mockClear();
  mockWorkerCtor.mockClear();
});

describe('queues module — initialization', () => {
  it('opens a single ioredis connection using BULLMQ_REDIS_URL', () => {
    expect(mockRedisCtor).toHaveBeenCalledWith(
      'redis://test-bullmq:6379',
      expect.objectContaining({ maxRetriesPerRequest: null }),
    );
  });

  it('exports the shared connection as `queueRedisConnection`', () => {
    expect(queueRedisConnection).toBe(mockRedisInstance);
  });
});

describe('QUEUE_NAMES', () => {
  it('exposes every queue name as a const string', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe('DEFAULT_JOB_OPTIONS', () => {
  it('has an entry for every queue name', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(DEFAULT_JOB_OPTIONS[name]).toBeDefined();
    }
  });

  it('removeOnComplete is true for every queue (no completed-job retention)', () => {
    for (const opts of Object.values(DEFAULT_JOB_OPTIONS)) {
      expect(opts.removeOnComplete).toBe(true);
    }
  });

  it('every queue has either attempts==1 (fire-and-forget) or a backoff strategy', () => {
    for (const [name, opts] of Object.entries(DEFAULT_JOB_OPTIONS)) {
      if (opts.attempts !== undefined && opts.attempts > 1) {
        expect(opts.backoff).toBeDefined();
        // The named queue payload must not be silently retried forever.
        expect(typeof name).toBe('string');
      }
    }
  });
});

describe('createQueue', () => {
  it("constructs a Queue with the shared connection and the queue's default options", () => {
    const q = createQueue(QUEUE_NAMES.WABOT_INBOUND);
    expect(q).toBeDefined();
    expect(mockQueueCtor).toHaveBeenCalledTimes(1);
    const [name, cfg] = mockQueueCtor.mock.calls[0];
    expect(name).toBe(QUEUE_NAMES.WABOT_INBOUND);
    expect(cfg.connection).toBe(mockRedisInstance);
    expect(cfg.defaultJobOptions).toEqual(
      DEFAULT_JOB_OPTIONS[QUEUE_NAMES.WABOT_INBOUND],
    );
  });

  it('honours a caller-supplied defaultJobOptions over the table entry', () => {
    const override = { attempts: 99, removeOnComplete: false };
    createQueue(QUEUE_NAMES.WABOT_INBOUND, override);
    const cfg = mockQueueCtor.mock.calls[0][1];
    expect(cfg.defaultJobOptions).toBe(override);
  });

  it('passes `undefined` defaultJobOptions for an unknown queue name (no entry to look up)', () => {
    createQueue('unknown-queue');
    const cfg = mockQueueCtor.mock.calls[0][1];
    expect(cfg.defaultJobOptions).toBeUndefined();
  });
});

describe('createWorker', () => {
  it("constructs a Worker with name, processor, shared connection, and the queue's default options", () => {
    const processor = jest.fn();
    createWorker(QUEUE_NAMES.HEYGEN_GENERATE, processor);
    const [name, proc, cfg] = mockWorkerCtor.mock.calls[0];
    expect(name).toBe(QUEUE_NAMES.HEYGEN_GENERATE);
    expect(proc).toBe(processor);
    expect(cfg.connection).toBe(mockRedisInstance);
    expect(cfg.defaultJobOptions).toEqual(
      DEFAULT_JOB_OPTIONS[QUEUE_NAMES.HEYGEN_GENERATE],
    );
  });

  it('honours a caller-supplied defaultJobOptions over the table entry', () => {
    const processor = jest.fn();
    const override = { attempts: 7 };
    createWorker(QUEUE_NAMES.HEYGEN_GENERATE, processor, override);
    const cfg = mockWorkerCtor.mock.calls[0][2];
    expect(cfg.defaultJobOptions).toBe(override);
  });

  it('omits defaultJobOptions entirely when neither the table nor the caller provides one', () => {
    const processor = jest.fn();
    createWorker('unknown-worker-queue', processor);
    const cfg = mockWorkerCtor.mock.calls[0][2];
    expect(cfg).not.toHaveProperty('defaultJobOptions');
    expect(cfg.connection).toBe(mockRedisInstance);
  });
});

// ─── mutation hardening: exact DEFAULT_JOB_OPTIONS per queue ──────────────

describe('DEFAULT_JOB_OPTIONS — exact per-queue shape', () => {
  // Frozen reference table: each entry is the EXACT options shape we ship to
  // production. Any drift here is intentional and must be reflected here too.
  const expected: Record<string, unknown> = {
    [QUEUE_NAMES.WABOT_INBOUND]: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: { count: 5000 },
    },
    [QUEUE_NAMES.HEYGEN_GENERATE]: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: { count: 5000 },
    },
    [QUEUE_NAMES.HEYGEN_INBOUND]: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: { count: 5000 },
    },
    [QUEUE_NAMES.ELEVENLABS_GENERATE]: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: { count: 5000 },
    },
    [QUEUE_NAMES.WHATSAPP_PRELOAD]: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: true,
      removeOnFail: { count: 5000 },
    },
    [QUEUE_NAMES.NOTIFIER]: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { count: 500 },
    },
    [QUEUE_NAMES.NOTIFIER_SEND]: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: true,
      removeOnFail: { count: 5000 },
    },
    [QUEUE_NAMES.MORNING_UPDATE]: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { count: 500 },
    },
    [QUEUE_NAMES.MORNING_UPDATE_SEND]: {
      attempts: 60,
      backoff: { type: 'fixed', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: { count: 5000 },
    },
    [QUEUE_NAMES.HAIL_MARY]: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { count: 500 },
    },
  };

  it.each(Object.entries(expected))(
    '%s has the documented JobsOptions',
    (queueName, opts) => {
      expect(DEFAULT_JOB_OPTIONS[queueName]).toEqual(opts);
    },
  );
});
