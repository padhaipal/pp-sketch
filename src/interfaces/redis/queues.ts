import { Queue, Worker, Processor, JobsOptions } from 'bullmq';
import Redis from 'ioredis';

export const QUEUE_NAMES = {
  WABOT_INBOUND: 'wabot-inbound',
  HEYGEN_GENERATE: 'heygen-generate',
  HEYGEN_INBOUND: 'heygen-inbound',
  ELEVENLABS_GENERATE: 'elevenlabs-generate',
  WHATSAPP_PRELOAD: 'whatsapp-preload',
  NOTIFIER: 'notifier',
  NOTIFIER_SEND: 'notifier-send',
  MORNING_UPDATE: 'morning-update',
  MORNING_UPDATE_SEND: 'morning-update-send',
} as const;

const connection = new Redis(process.env.BULLMQ_REDIS_URL!, {
  maxRetriesPerRequest: null,
});

export { connection as queueRedisConnection };

export const DEFAULT_JOB_OPTIONS: Record<string, JobsOptions> = {
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
  // Per-user job. Worker requeues itself with a 1 s delay when the report card
  // is still rendering — high attempt count tolerates this and WhatsApp 130429.
  [QUEUE_NAMES.MORNING_UPDATE_SEND]: {
    attempts: 60,
    backoff: { type: 'fixed', delay: 1000 },
    removeOnComplete: true,
    removeOnFail: { count: 5000 },
  },
};

export function createQueue(
  name: string,
  defaultJobOptions?: JobsOptions,
): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: defaultJobOptions ?? DEFAULT_JOB_OPTIONS[name],
  });
}

export function createWorker<T = any>(
  name: string,
  processor: Processor<T>,
  defaultJobOptions?: JobsOptions,
): Worker<T> {
  return new Worker<T>(name, processor, {
    connection,
    ...(defaultJobOptions
      ? { defaultJobOptions }
      : DEFAULT_JOB_OPTIONS[name]
        ? { defaultJobOptions: DEFAULT_JOB_OPTIONS[name] }
        : {}),
  });
}
