// queue-metrics.ts wires BullMQ Worker terminal events + a periodic
// queue-depth gauge into OTel histograms/counters. We mock the meter and
// the @opentelemetry/api propagation surface so the spec runs in-process
// without a real Redis or NodeSDK.

const mockHistogramRecord = jest.fn();
const mockCounterAdd = jest.fn();
const mockGaugeObserve = jest.fn();
const mockGaugeAddCallback = jest.fn();
let gaugeCallback: ((r: { observe: jest.Mock }) => Promise<void>) | undefined;

const mockCreateHistogram = jest.fn().mockReturnValue({
  record: mockHistogramRecord,
});
const mockCreateCounter = jest.fn().mockReturnValue({
  add: mockCounterAdd,
});
const mockCreateObservableGauge = jest.fn().mockReturnValue({
  addCallback: (cb: (r: { observe: jest.Mock }) => Promise<void>) => {
    mockGaugeAddCallback(cb);
    gaugeCallback = cb;
  },
});

const mockGetMeter = jest.fn().mockReturnValue({
  createHistogram: (...a: unknown[]) => mockCreateHistogram(...a),
  createCounter: (...a: unknown[]) => mockCreateCounter(...a),
  createObservableGauge: (...a: unknown[]) => mockCreateObservableGauge(...a),
});

const mockPropExtract = jest.fn();
const mockPropGetBaggage = jest.fn();
const mockContextActive = jest.fn().mockReturnValue('active-ctx');

jest.mock('@opentelemetry/api', () => ({
  metrics: { getMeter: (...a: unknown[]) => mockGetMeter(...a) },
  propagation: {
    extract: (...a: unknown[]) => mockPropExtract(...a),
    getBaggage: (...a: unknown[]) => mockPropGetBaggage(...a),
  },
  context: {
    active: () => mockContextActive(),
  },
}));

import {
  _resetTrackedQueuesForTest,
  instrumentQueue,
  instrumentWorker,
  readJobBaggageAttrs,
} from './queue-metrics';

type WorkerEvent = 'completed' | 'failed' | 'stalled' | 'error';
type WorkerListener = (...args: unknown[]) => void;

function makeWorker(): {
  on: jest.Mock;
  listeners: Map<WorkerEvent, WorkerListener[]>;
  emit: (event: WorkerEvent, ...args: unknown[]) => void;
} {
  const listeners = new Map<WorkerEvent, WorkerListener[]>();
  const on = jest.fn((event: WorkerEvent, listener: WorkerListener) => {
    const existing = listeners.get(event) ?? [];
    existing.push(listener);
    listeners.set(event, existing);
  });
  const emit = (event: WorkerEvent, ...args: unknown[]): void => {
    for (const l of listeners.get(event) ?? []) l(...args);
  };
  return { on, listeners, emit };
}

function makeJob(opts: {
  timestamp?: number;
  processedOn?: number;
  carrier?: Record<string, string>;
}): {
  timestamp?: number;
  processedOn?: number;
  data: { otel?: { carrier?: Record<string, string> } };
} {
  return {
    timestamp: opts.timestamp,
    processedOn: opts.processedOn,
    data: opts.carrier ? { otel: { carrier: opts.carrier } } : {},
  };
}

function makeBaggage(entries: Record<string, string>): {
  getEntry: jest.Mock;
} {
  return {
    getEntry: jest.fn((key: string) =>
      key in entries ? { value: entries[key] } : undefined,
    ),
  };
}

beforeEach(() => {
  mockHistogramRecord.mockReset();
  mockCounterAdd.mockReset();
  mockGaugeObserve.mockReset();
  mockPropExtract.mockReset().mockReturnValue('extracted-ctx');
  mockPropGetBaggage.mockReset().mockReturnValue(undefined);
  _resetTrackedQueuesForTest();
});

describe('meter registration (module load)', () => {
  it('opens a meter named "pp.bullmq"', () => {
    expect(mockGetMeter).toHaveBeenCalledWith('pp.bullmq');
  });

  it.each<[name: string, fn: jest.Mock]>([
    ['pp.bullmq.job.dwell_duration_ms', mockCreateHistogram],
    ['pp.bullmq.job.work_duration_ms', mockCreateHistogram],
    ['pp.bullmq.job.outcomes_total', mockCreateCounter],
    ['pp.bullmq.queue.depth', mockCreateObservableGauge],
  ])('registers metric %s', (metricName, factory) => {
    const calls = factory.mock.calls.filter((c) => c[0] === metricName);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('declares the same explicit bucket boundaries for both histograms', () => {
    const histogramCalls = mockCreateHistogram.mock.calls.filter(
      ([n]) => typeof n === 'string' && n.includes('duration_ms'),
    );
    expect(histogramCalls.length).toBe(2);
    const buckets = (
      histogramCalls[0][1] as {
        advice: { explicitBucketBoundaries: number[] };
      }
    ).advice.explicitBucketBoundaries;
    expect(buckets[0]).toBe(5);
    expect(buckets[buckets.length - 1]).toBe(60000);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]).toBeGreaterThan(buckets[i - 1]);
    }
    expect(
      (
        histogramCalls[1][1] as {
          advice: { explicitBucketBoundaries: number[] };
        }
      ).advice.explicitBucketBoundaries,
    ).toEqual(buckets);
  });
});

describe('readJobBaggageAttrs', () => {
  it('returns load_test="false" when the job carries no otel carrier', () => {
    expect(readJobBaggageAttrs(makeJob({}) as never)).toEqual({
      load_test: 'false',
    });
    expect(mockPropExtract).not.toHaveBeenCalled();
  });

  it('returns load_test="false" when extract yields no baggage', () => {
    mockPropGetBaggage.mockReturnValue(undefined);
    const job = makeJob({ carrier: { traceparent: 'tp' } });
    expect(readJobBaggageAttrs(job as never)).toEqual({ load_test: 'false' });
    expect(mockPropExtract).toHaveBeenCalledWith('active-ctx', {
      traceparent: 'tp',
    });
  });

  it('extracts load_test=true and test_phase from the carrier', () => {
    mockPropGetBaggage.mockReturnValue(
      makeBaggage({
        'padhaipal.load_test': 'true',
        'padhaipal.test_phase': 'phase_2',
      }),
    );
    const job = makeJob({ carrier: { baggage: 'x' } });
    expect(readJobBaggageAttrs(job as never)).toEqual({
      load_test: 'true',
      test_phase: 'phase_2',
    });
  });

  it('omits test_phase when its baggage value is the empty string', () => {
    mockPropGetBaggage.mockReturnValue(
      makeBaggage({
        'padhaipal.load_test': 'true',
        'padhaipal.test_phase': '',
      }),
    );
    const attrs = readJobBaggageAttrs(makeJob({ carrier: {} }) as never);
    expect(attrs.test_phase).toBeUndefined();
    expect(attrs.load_test).toBe('true');
  });
});

describe('instrumentWorker — terminal event handlers', () => {
  it('completed: records dwell + work + outcome=completed with baggage attrs', () => {
    mockPropGetBaggage.mockReturnValue(
      makeBaggage({ 'padhaipal.load_test': 'true' }),
    );
    const worker = makeWorker();
    instrumentWorker(worker as never, 'wabot-inbound');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const job = makeJob({
      timestamp: 1_000,
      processedOn: 3_000,
      carrier: { baggage: 'x' },
    });
    worker.emit('completed', job);
    nowSpy.mockRestore();

    expect(mockHistogramRecord).toHaveBeenCalledWith(2_000, {
      queue_name: 'wabot-inbound',
      load_test: 'true',
    });
    expect(mockHistogramRecord).toHaveBeenCalledWith(7_000, {
      queue_name: 'wabot-inbound',
      load_test: 'true',
    });
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      queue_name: 'wabot-inbound',
      load_test: 'true',
      outcome: 'completed',
    });
  });

  it('completed: clamps dwell + work to 0 when timestamps go backwards', () => {
    const worker = makeWorker();
    instrumentWorker(worker as never, 'q');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(100);
    const job = makeJob({
      timestamp: 5_000,
      processedOn: 1_000,
      carrier: {},
    });
    worker.emit('completed', job);
    nowSpy.mockRestore();
    expect(mockHistogramRecord).toHaveBeenCalledWith(0, {
      queue_name: 'q',
      load_test: 'false',
    });
    const workCall = mockHistogramRecord.mock.calls[1] as [
      number,
      Record<string, string>,
    ];
    expect(workCall[0]).toBe(0);
  });

  it('completed: skips dwell + work when timestamp/processedOn are absent', () => {
    const worker = makeWorker();
    instrumentWorker(worker as never, 'q');
    worker.emit('completed', makeJob({ carrier: {} }));
    expect(mockHistogramRecord).not.toHaveBeenCalled();
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      queue_name: 'q',
      load_test: 'false',
      outcome: 'completed',
    });
  });

  it('failed (with job): records dwell + work + outcome=failed', () => {
    const worker = makeWorker();
    instrumentWorker(worker as never, 'q');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(5_000);
    worker.emit(
      'failed',
      makeJob({ timestamp: 1_000, processedOn: 2_000, carrier: {} }),
      new Error('boom'),
    );
    nowSpy.mockRestore();
    expect(mockHistogramRecord).toHaveBeenCalledTimes(2);
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      queue_name: 'q',
      load_test: 'false',
      outcome: 'failed',
    });
  });

  it('failed (no job): records ONLY outcome=failed with default attrs', () => {
    const worker = makeWorker();
    instrumentWorker(worker as never, 'q');
    worker.emit('failed', undefined, new Error('boom'));
    expect(mockHistogramRecord).not.toHaveBeenCalled();
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      queue_name: 'q',
      outcome: 'failed',
      load_test: 'false',
    });
  });

  it('stalled: records ONLY outcome=stalled with default attrs', () => {
    const worker = makeWorker();
    instrumentWorker(worker as never, 'q');
    worker.emit('stalled', 'job-id-1');
    expect(mockHistogramRecord).not.toHaveBeenCalled();
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      queue_name: 'q',
      outcome: 'stalled',
      load_test: 'false',
    });
  });

  it('subscribes to completed, failed, and stalled', () => {
    const worker = makeWorker();
    instrumentWorker(worker as never, 'q');
    const events = worker.on.mock.calls.map((c) => c[0] as string);
    expect(events).toEqual(['completed', 'failed', 'stalled']);
  });
});

describe('instrumentQueue + depth gauge callback', () => {
  function makeQueue(counts: {
    waiting: number;
    active: number;
    delayed: number;
  }): { getJobCounts: jest.Mock } {
    return {
      getJobCounts: jest.fn().mockResolvedValue(counts),
    };
  }

  it('observes waiting/active/delayed counts for every tracked queue', async () => {
    const q1 = makeQueue({ waiting: 3, active: 1, delayed: 0 });
    const q2 = makeQueue({ waiting: 10, active: 2, delayed: 5 });
    instrumentQueue(q1 as never, 'wabot-inbound');
    instrumentQueue(q2 as never, 'notifier');

    expect(gaugeCallback).toBeDefined();
    const observable = { observe: mockGaugeObserve };
    await gaugeCallback!(observable);

    expect(q1.getJobCounts).toHaveBeenCalledWith(
      'waiting',
      'active',
      'delayed',
    );
    expect(mockGaugeObserve).toHaveBeenCalledWith(3, {
      queue_name: 'wabot-inbound',
      state: 'waiting',
    });
    expect(mockGaugeObserve).toHaveBeenCalledWith(1, {
      queue_name: 'wabot-inbound',
      state: 'active',
    });
    expect(mockGaugeObserve).toHaveBeenCalledWith(0, {
      queue_name: 'wabot-inbound',
      state: 'delayed',
    });
    expect(mockGaugeObserve).toHaveBeenCalledWith(10, {
      queue_name: 'notifier',
      state: 'waiting',
    });
  });

  it('treats undefined counts as 0', async () => {
    const q = { getJobCounts: jest.fn().mockResolvedValue({}) };
    instrumentQueue(q as never, 'q');
    await gaugeCallback!({ observe: mockGaugeObserve });
    expect(mockGaugeObserve).toHaveBeenCalledWith(0, {
      queue_name: 'q',
      state: 'waiting',
    });
    expect(mockGaugeObserve).toHaveBeenCalledWith(0, {
      queue_name: 'q',
      state: 'active',
    });
    expect(mockGaugeObserve).toHaveBeenCalledWith(0, {
      queue_name: 'q',
      state: 'delayed',
    });
  });

  it('swallows errors from getJobCounts without throwing', async () => {
    const broken = {
      getJobCounts: jest.fn().mockRejectedValue(new Error('redis-down')),
    };
    const ok = { getJobCounts: jest.fn().mockResolvedValue({ waiting: 1 }) };
    instrumentQueue(broken as never, 'broken');
    instrumentQueue(ok as never, 'ok');
    await expect(
      gaugeCallback!({ observe: mockGaugeObserve }),
    ).resolves.toBeUndefined();
    expect(mockGaugeObserve).toHaveBeenCalledWith(1, {
      queue_name: 'ok',
      state: 'waiting',
    });
  });
});
