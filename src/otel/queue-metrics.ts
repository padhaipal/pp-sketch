import {
  context,
  metrics,
  propagation,
  type ObservableResult,
} from '@opentelemetry/api';
import type { Job, Queue, Worker } from 'bullmq';
import { BAGGAGE_LOAD_TEST, BAGGAGE_TEST_PHASE } from './baggage-keys';

// Per-queue BullMQ observability for pp-sketch. Surfaces three latencies +
// a depth gauge so the daily digest can isolate where messages are
// spending time:
//
//   pp.bullmq.queue.depth          — current waiting/active/delayed counts
//   pp.bullmq.job.dwell_duration_ms — job.timestamp → job.processedOn
//   pp.bullmq.job.work_duration_ms  — job.processedOn → terminal event
//   pp.bullmq.job.outcomes_total    — completed | failed | stalled
//
// All recordings carry queue_name + load_test (+ test_phase when set) so
// the digest can filter to load-test traffic only. load_test / test_phase
// are recovered from the job's stashed OtelCarrier rather than from the
// active context, because worker terminal events fire AFTER the processor
// function has returned — by then context.active() no longer carries the
// per-job baggage.

const meter = metrics.getMeter('pp.bullmq');

const HISTOGRAM_BUCKETS_MS: readonly number[] = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 60000,
] as const;

export const dwellHistogram = meter.createHistogram(
  'pp.bullmq.job.dwell_duration_ms',
  {
    description:
      'Milliseconds a job waited in the queue between enqueue and worker pickup.',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [...HISTOGRAM_BUCKETS_MS] },
  },
);

export const workHistogram = meter.createHistogram(
  'pp.bullmq.job.work_duration_ms',
  {
    description:
      'Milliseconds a worker spent processing a job, from pickup to terminal event.',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [...HISTOGRAM_BUCKETS_MS] },
  },
);

export const outcomeCounter = meter.createCounter(
  'pp.bullmq.job.outcomes_total',
  {
    description: 'Count of jobs reaching a terminal state, labeled by outcome.',
  },
);

export const depthGauge = meter.createObservableGauge('pp.bullmq.queue.depth', {
  description:
    'Current job counts per (queue, state). state in {waiting, active, delayed}.',
});

export type JobOutcome = 'completed' | 'failed' | 'stalled';

interface JobDataWithOtel {
  otel?: { carrier?: Record<string, string> };
}

// Reads padhaipal.load_test + padhaipal.test_phase off the W3C baggage that
// the producer stashed in the job's OtelCarrier. Returns defaults if the
// job pre-dates the carrier convention or baggage is absent.
export function readJobBaggageAttrs(job: Job): Record<string, string> {
  const carrier = (job.data as JobDataWithOtel | undefined)?.otel?.carrier;
  if (!carrier) return { load_test: 'false' };
  const ctx = propagation.extract(context.active(), carrier);
  const baggage = propagation.getBaggage(ctx);
  if (!baggage) return { load_test: 'false' };
  const loadTest = baggage.getEntry(BAGGAGE_LOAD_TEST)?.value ?? 'false';
  const testPhase = baggage.getEntry(BAGGAGE_TEST_PHASE)?.value;
  const attrs: Record<string, string> = { load_test: loadTest };
  if (typeof testPhase === 'string' && testPhase.length > 0) {
    attrs.test_phase = testPhase;
  }
  return attrs;
}

const trackedQueues = new Map<string, Queue>();

depthGauge.addCallback(async (observableResult: ObservableResult) => {
  for (const [name, queue] of trackedQueues) {
    try {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
      observableResult.observe(counts.waiting ?? 0, {
        queue_name: name,
        state: 'waiting',
      });
      observableResult.observe(counts.active ?? 0, {
        queue_name: name,
        state: 'active',
      });
      observableResult.observe(counts.delayed ?? 0, {
        queue_name: name,
        state: 'delayed',
      });
    } catch {
      // Queue closed during shutdown or Redis hiccup — skip this sample.
    }
  }
});

export function instrumentQueue(queue: Queue, name: string): void {
  trackedQueues.set(name, queue);
}

// Test-only: clears the singleton tracked map between specs.
export function _resetTrackedQueuesForTest(): void {
  trackedQueues.clear();
}

function recordTerminal(name: string, job: Job, outcome: JobOutcome): void {
  const now = Date.now();
  const enqueuedAt =
    typeof job.timestamp === 'number' ? job.timestamp : undefined;
  const startedAt =
    typeof job.processedOn === 'number' ? job.processedOn : undefined;
  const baseAttrs = { queue_name: name, ...readJobBaggageAttrs(job) };

  if (enqueuedAt !== undefined && startedAt !== undefined) {
    dwellHistogram.record(Math.max(0, startedAt - enqueuedAt), baseAttrs);
  }
  if (startedAt !== undefined) {
    workHistogram.record(Math.max(0, now - startedAt), baseAttrs);
  }
  outcomeCounter.add(1, { ...baseAttrs, outcome });
}

export function instrumentWorker(worker: Worker, name: string): void {
  worker.on('completed', (job: Job) => {
    recordTerminal(name, job, 'completed');
  });
  worker.on('failed', (job: Job | undefined, _err: Error) => {
    if (job) {
      recordTerminal(name, job, 'failed');
    } else {
      outcomeCounter.add(1, {
        queue_name: name,
        outcome: 'failed',
        load_test: 'false',
      });
    }
  });
  worker.on('stalled', () => {
    outcomeCounter.add(1, {
      queue_name: name,
      outcome: 'stalled',
      load_test: 'false',
    });
  });
}
