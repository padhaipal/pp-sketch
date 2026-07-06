import { Queue, Worker, Processor, JobsOptions, WorkerOptions } from 'bullmq';
import Redis from 'ioredis';
import { instrumentQueue, instrumentWorker } from '../../otel/queue-metrics';

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
  HAIL_MARY: 'hail-mary',
  MIRROR: 'mirror',
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
  // Per-user job. Worker requeues itself (throw) while the report card
  // preload is still in flight — exponential backoff covers ~43 min of
  // waiting in 10 attempts (gaps 5s, 10s, 20s, … 1280s) instead of the
  // old 60×1s spin that produced error-log storms and gave up at 60s.
  [QUEUE_NAMES.MORNING_UPDATE_SEND]: {
    attempts: 10,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: { count: 5000 },
  },
  [QUEUE_NAMES.HAIL_MARY]: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: { count: 500 },
  },
  // Mirror is fired by GH Actions on a daily cron. attempts:1 — no in-run
  // retry; next-day trigger is the retry path. Singleton jobId is set by the
  // service, not here.
  [QUEUE_NAMES.MIRROR]: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: { count: 500 },
  },
};

export function createQueue(
  name: string,
  defaultJobOptions?: JobsOptions,
): Queue {
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: defaultJobOptions ?? DEFAULT_JOB_OPTIONS[name],
  });
  instrumentQueue(queue, name);
  return queue;
}

export function createWorker<T = any>(
  name: string,
  processor: Processor<T>,
  workerOptions?: Pick<WorkerOptions, 'concurrency' | 'limiter'>,
): Worker<T> {
  const worker = new Worker<T>(name, processor, {
    connection,
    ...workerOptions,
  });
  instrumentWorker(worker, name);
  return worker;
}
