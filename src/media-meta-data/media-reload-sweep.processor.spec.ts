const mockAddBulk = jest.fn();
const mockCreateQueue = jest.fn(() => ({ addBulk: mockAddBulk }));
jest.mock('../interfaces/redis/queues', () => ({
  createQueue: (...args: unknown[]) => mockCreateQueue(...args),
  QUEUE_NAMES: {
    WHATSAPP_PRELOAD: 'whatsapp-preload',
    MEDIA_RELOAD_SWEEP: 'media-reload-sweep',
  },
}));

const mockSpan = {
  setAttribute: jest.fn(),
  setStatus: jest.fn(),
  recordException: jest.fn(),
  end: jest.fn(),
};
const mockInjectCarrier = jest.fn(() => ({ traceparent: 'tp' }));
jest.mock('../otel/otel', () => ({
  tracer: {
    startActiveSpan: (_name: string, fn: (span: unknown) => unknown) =>
      fn(mockSpan),
  },
  injectCarrier: (...args: unknown[]) => mockInjectCarrier(...args),
}));

// Capture the backlog gauge's observation callback so tests can fire it the
// way the OTel SDK would on each metric collection.
let gaugeCallback: ((result: { observe: jest.Mock }) => void) | undefined;
jest.mock('@opentelemetry/api', () => {
  const actual =
    jest.requireActual<typeof import('@opentelemetry/api')>(
      '@opentelemetry/api',
    );
  return {
    ...actual,
    metrics: {
      ...actual.metrics,
      getMeter: () => ({
        createObservableGauge: () => ({
          addCallback: (cb: (result: { observe: jest.Mock }) => void) => {
            gaugeCallback = cb;
          },
        }),
      }),
    },
  };
});

import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import { processMediaReloadSweepJob } from './media-reload-sweep.processor';

type Row = { id: string; s3_key: string; status: string };

function makeJob(): Job {
  return { id: 'sweep-job-1' } as unknown as Job;
}

// dataSource.query is called twice per run: count(*) first, then the
// batched SELECT.
function makeDataSource(opts: {
  backlog: number;
  rows?: Row[];
  countError?: Error;
  selectError?: Error;
}): DataSource & { query: jest.Mock } {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('count(*)')) {
      if (opts.countError) return Promise.reject(opts.countError);
      return Promise.resolve([{ count: String(opts.backlog) }]);
    }
    if (opts.selectError) return Promise.reject(opts.selectError);
    return Promise.resolve(opts.rows ?? []);
  });
  return { query } as unknown as DataSource & { query: jest.Mock };
}

function rows(n: number, status = 'ready'): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `mm-${i}`,
    s3_key: `s3/${i}`,
    status,
  }));
}

function allEnqueued(): {
  name: string;
  data: Record<string, unknown>;
  opts: { jobId: string };
}[] {
  return mockAddBulk.mock.calls.flatMap(
    (c) =>
      c[0] as {
        name: string;
        data: Record<string, unknown>;
        opts: { jobId: string };
      }[],
  );
}

beforeEach(() => {
  mockAddBulk.mockReset().mockResolvedValue([]);
  mockInjectCarrier.mockClear();
  mockSpan.setAttribute.mockClear();
  mockSpan.setStatus.mockClear();
  mockSpan.recordException.mockClear();
  mockSpan.end.mockClear();
  delete process.env.MEDIA_RELOAD_SWEEP_BATCH;
});

describe('processMediaReloadSweepJob — eligibility query', () => {
  it('encodes every agreed filter in the WHERE clause', async () => {
    const ds = makeDataSource({ backlog: 1, rows: rows(1) });
    await processMediaReloadSweepJob(makeJob(), ds);

    const selectSql = ds.query.mock.calls[1][0] as string;
    // Visibility filters (re-derived per project convention).
    expect(selectSql).toContain('rolled_back = false');
    expect(selectSql).toContain('s3_key IS NOT NULL');
    expect(selectSql).toContain('state_transition_id IS NOT NULL');
    // Overdue branch: ready + stamp older than 20 days or never stamped.
    expect(selectSql).toContain("status = 'ready'");
    expect(selectSql).toContain('wa_uploaded_at IS NULL');
    expect(selectSql).toContain("interval '20 days'");
    // Rescue branch: stranded first uploads, aged 6h to avoid racing an
    // in-flight preload attempt.
    expect(selectSql).toContain("status IN ('created', 'queued')");
    expect(selectSql).toContain("interval '6 hours'");
    // 'failed' (permanent rejection) must never be selected.
    expect(selectSql).not.toContain("'failed'");
    // Oldest/unknown-age first, capped.
    expect(selectSql).toContain('ORDER BY wa_uploaded_at ASC NULLS FIRST');
    expect(selectSql).toContain('LIMIT $1');
  });

  it('count query and select query share the same WHERE clause', async () => {
    const ds = makeDataSource({ backlog: 1, rows: rows(1) });
    await processMediaReloadSweepJob(makeJob(), ds);

    const countSql = ds.query.mock.calls[0][0] as string;
    const selectSql = ds.query.mock.calls[1][0] as string;
    const whereOf = (sql: string) => sql.split('WHERE')[1].split('ORDER BY')[0];
    expect(whereOf(countSql).trim()).toBe(whereOf(selectSql).trim());
  });

  it('passes the default batch limit 9000 as the SELECT parameter', async () => {
    const ds = makeDataSource({ backlog: 1, rows: rows(1) });
    await processMediaReloadSweepJob(makeJob(), ds);

    expect(ds.query.mock.calls[1][1]).toEqual([9000]);
  });

  it('honors the MEDIA_RELOAD_SWEEP_BATCH env override', async () => {
    process.env.MEDIA_RELOAD_SWEEP_BATCH = '250';
    const ds = makeDataSource({ backlog: 1, rows: rows(1) });
    await processMediaReloadSweepJob(makeJob(), ds);

    expect(ds.query.mock.calls[1][1]).toEqual([250]);
  });
});

describe('processMediaReloadSweepJob — backlog 0 early exit', () => {
  it('skips the SELECT and enqueues nothing', async () => {
    const ds = makeDataSource({ backlog: 0 });
    await processMediaReloadSweepJob(makeJob(), ds);

    expect(ds.query).toHaveBeenCalledTimes(1); // count only
    expect(mockAddBulk).not.toHaveBeenCalled();
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });
});

describe('processMediaReloadSweepJob — enqueue payload', () => {
  it("targets the whatsapp-preload queue with name sweep-<id> and the row's s3_key", async () => {
    const ds = makeDataSource({
      backlog: 1,
      rows: [{ id: 'mm-7', s3_key: 's3/seven', status: 'ready' }],
    });
    await processMediaReloadSweepJob(makeJob(), ds);

    expect(mockCreateQueue).toHaveBeenCalledWith('whatsapp-preload');
    const [entry] = allEnqueued();
    expect(entry.name).toBe('sweep-mm-7');
    expect(entry.data).toMatchObject({
      media_metadata_id: 'mm-7',
      s3_key: 's3/seven',
      otel_carrier: { traceparent: 'tp' },
    });
  });

  it("'ready' rows are true reloads (reload=true: url refresh only)", async () => {
    const ds = makeDataSource({ backlog: 1, rows: rows(1, 'ready') });
    await processMediaReloadSweepJob(makeJob(), ds);

    expect(allEnqueued()[0].data.reload).toBe(true);
  });

  it.each(['created', 'queued'])(
    "stranded '%s' rows are rescues (reload=false: success flips them ready)",
    async (status) => {
      const ds = makeDataSource({ backlog: 1, rows: rows(1, status) });
      await processMediaReloadSweepJob(makeJob(), ds);

      expect(allEnqueued()[0].data.reload).toBe(false);
    },
  );

  it('jobId is hour-bucketed: dedupes within the hour, retries next hour', async () => {
    const ds = makeDataSource({ backlog: 1, rows: rows(1) });

    const hourMs = 3_600_000;
    const t0 = 1_783_440_000_000; // any fixed instant
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await processMediaReloadSweepJob(makeJob(), ds);
    const idHour0 = allEnqueued()[0].opts.jobId;

    mockAddBulk.mockClear();
    dateSpy.mockReturnValue(t0 + hourMs);
    await processMediaReloadSweepJob(makeJob(), ds);
    const idHour1 = allEnqueued()[0].opts.jobId;
    dateSpy.mockRestore();

    expect(idHour0).toBe(`sweep-mm-0-${Math.floor(t0 / hourMs)}`);
    expect(idHour1).toBe(`sweep-mm-0-${Math.floor(t0 / hourMs) + 1}`);
    expect(idHour0).not.toBe(idHour1);
  });
});

describe('processMediaReloadSweepJob — addBulk chunking', () => {
  it('splits 2500 rows into chunks of 1000/1000/500', async () => {
    const ds = makeDataSource({ backlog: 2500, rows: rows(2500) });
    await processMediaReloadSweepJob(makeJob(), ds);

    expect(mockAddBulk).toHaveBeenCalledTimes(3);
    expect((mockAddBulk.mock.calls[0][0] as unknown[]).length).toBe(1000);
    expect((mockAddBulk.mock.calls[1][0] as unknown[]).length).toBe(1000);
    expect((mockAddBulk.mock.calls[2][0] as unknown[]).length).toBe(500);
    // No row lost or duplicated across chunks.
    const ids = new Set(allEnqueued().map((e) => e.name));
    expect(ids.size).toBe(2500);
  });

  it('exactly one chunk when rows <= 1000', async () => {
    const ds = makeDataSource({ backlog: 1000, rows: rows(1000) });
    await processMediaReloadSweepJob(makeJob(), ds);

    expect(mockAddBulk).toHaveBeenCalledTimes(1);
  });
});

describe('processMediaReloadSweepJob — observability', () => {
  it('pp.media_reload.backlog gauge: silent before the first run, observes the latest backlog after', async () => {
    expect(gaugeCallback).toBeDefined();

    // No run yet in this test (module state may carry earlier observations,
    // so only assert the post-run value strictly).
    const ds = makeDataSource({ backlog: 42, rows: rows(1) });
    await processMediaReloadSweepJob(makeJob(), ds);

    const observe = jest.fn();
    gaugeCallback!({ observe });
    expect(observe).toHaveBeenCalledWith(42);
  });

  it('records backlog, selected, and reload/rescue split as span attributes', async () => {
    const ds = makeDataSource({
      backlog: 5,
      rows: [...rows(2, 'ready'), ...rows(1, 'queued')],
    });
    await processMediaReloadSweepJob(makeJob(), ds);

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('sweep.backlog', 5);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('sweep.selected', 3);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('sweep.reloads', 2);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('sweep.rescues', 1);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'sweep.batch_limit',
      9000,
    );
  });
});

describe('processMediaReloadSweepJob — failure paths', () => {
  it('rethrows on count-query failure and marks the span errored', async () => {
    const ds = makeDataSource({
      backlog: 0,
      countError: new Error('pg down'),
    });

    await expect(processMediaReloadSweepJob(makeJob(), ds)).rejects.toThrow(
      'pg down',
    );
    expect(mockSpan.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'pg down' }),
    );
    expect(mockSpan.recordException).toHaveBeenCalled();
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
    expect(mockAddBulk).not.toHaveBeenCalled();
  });

  it('rethrows on addBulk failure (next hourly run is the retry path)', async () => {
    const ds = makeDataSource({ backlog: 1, rows: rows(1) });
    mockAddBulk.mockRejectedValue(new Error('redis down'));

    await expect(processMediaReloadSweepJob(makeJob(), ds)).rejects.toThrow(
      'redis down',
    );
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });
});

// Keep last: isolateModules re-captures gaugeCallback from a fresh module
// copy, so any test after this one would observe the wrong instance.
describe('processMediaReloadSweepJob — gauge before first run', () => {
  it('observes nothing until a sweep has recorded a backlog', () => {
    jest.isolateModules(() => {
      require('./media-reload-sweep.processor');
    });
    const observe = jest.fn();
    gaugeCallback!({ observe });
    expect(observe).not.toHaveBeenCalled();
  });
});
