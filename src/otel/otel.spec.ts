// otel.ts has two distinct concerns:
//
//   1. Initialization (`initOtel`) — boots a real NodeSDK + signal handlers.
//   2. Per-call helpers — extractSpan, startChildSpan, startChildSpanWithContext,
//      startRootSpan, injectCarrier, injectCarrierFromContext.
//
// We mock the entire @opentelemetry/api surface so the helpers can be
// tested as pure functions, and mock NodeSDK + the exporters so initOtel
// doesn't actually open OTLP sockets.

const ROOT_CONTEXT = { __ctx: 'root' } as const;
const mockExtractedCtx = { __ctx: 'extracted' };

const mockTracerStartSpan = jest.fn();
const mockTracer = { startSpan: mockTracerStartSpan };

const mockTraceGetTracer = jest.fn(() => mockTracer);
const mockTraceSetSpan = jest.fn();

const mockPropagationExtract = jest.fn(() => mockExtractedCtx);
const mockPropagationInject = jest.fn();

const mockDiagSetLogger = jest.fn();

jest.mock('@opentelemetry/api', () => {
  const DiagLogLevel = { WARN: 30, ERROR: 70, NONE: 99 };
  return {
    trace: {
      getTracer: (...args: unknown[]) => mockTraceGetTracer(...args),
      setSpan: (...args: unknown[]) => mockTraceSetSpan(...args),
    },
    propagation: {
      extract: (...args: unknown[]) => mockPropagationExtract(...args),
      inject: (...args: unknown[]) => mockPropagationInject(...args),
    },
    diag: { setLogger: (...args: unknown[]) => mockDiagSetLogger(...args) },
    DiagConsoleLogger: jest.fn(),
    DiagLogLevel,
    ROOT_CONTEXT,
  };
});

const mockSdkStart = jest.fn();
const mockSdkShutdown = jest.fn();
const mockNodeSdkCtor = jest.fn();
jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: jest.fn().mockImplementation((cfg) => {
    mockNodeSdkCtor(cfg);
    return { start: mockSdkStart, shutdown: mockSdkShutdown };
  }),
}));

// Each exporter / processor needs a no-throw constructor mock so the
// NodeSDK config can be built. We don't assert their internals — just
// that they were wired into the SDK.
jest.mock('@opentelemetry/exporter-logs-otlp-proto', () => ({
  OTLPLogExporter: jest.fn(),
}));
jest.mock('@opentelemetry/exporter-metrics-otlp-proto', () => ({
  OTLPMetricExporter: jest.fn(),
}));
jest.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: jest.fn(),
}));
jest.mock('@opentelemetry/sdk-logs', () => ({
  BatchLogRecordProcessor: jest.fn(),
}));
jest.mock('@opentelemetry/sdk-metrics', () => ({
  PeriodicExportingMetricReader: jest.fn(),
  AggregationType: { DROP: 0, EXPLICIT_BUCKET_HISTOGRAM: 1 },
  createAllowListAttributesProcessor: jest.fn(() => 'allow-list-processor'),
}));
jest.mock('@opentelemetry/sdk-trace-base', () => ({
  BatchSpanProcessor: jest.fn().mockImplementation((exporter: unknown) => ({
    tag: 'batch',
    exporter,
  })),
}));
jest.mock('@opentelemetry/core', () => ({
  CompositePropagator: jest.fn().mockImplementation((cfg: unknown) => ({
    tag: 'composite',
    cfg,
  })),
  W3CTraceContextPropagator: jest
    .fn()
    .mockImplementation(() => ({ tag: 'trace-prop' })),
  W3CBaggagePropagator: jest
    .fn()
    .mockImplementation(() => ({ tag: 'baggage-prop' })),
}));
jest.mock('@opentelemetry/instrumentation-undici', () => ({
  UndiciInstrumentation: jest
    .fn()
    .mockImplementation(() => ({ tag: 'undici-instrumentation' })),
}));
jest.mock('./baggage-span-processor', () => ({
  BaggageSpanProcessor: jest.fn().mockImplementation((keys: unknown) => ({
    tag: 'baggage',
    keys,
  })),
}));
jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: jest.fn(() => []),
}));

import {
  extractSpan,
  startChildSpan,
  startChildSpanWithContext,
  startRootSpan,
  injectCarrier,
  injectCarrierFromContext,
  initOtel,
} from './otel';

beforeEach(() => {
  mockTracerStartSpan.mockReset();
  mockTraceGetTracer.mockClear();
  mockTraceSetSpan.mockReset();
  mockPropagationExtract.mockReset().mockReturnValue(mockExtractedCtx);
  mockPropagationInject.mockReset();
  mockDiagSetLogger.mockReset();
  mockSdkStart.mockReset();
  mockSdkShutdown.mockReset();
  mockNodeSdkCtor.mockClear();
});

describe('extractSpan', () => {
  it('returns propagation.extract(ROOT_CONTEXT, carrier)', () => {
    const carrier = { traceparent: 'tp' };
    const out = extractSpan(carrier);
    expect(out).toBe(mockExtractedCtx);
    expect(mockPropagationExtract).toHaveBeenCalledWith(ROOT_CONTEXT, carrier);
  });
});

describe('startChildSpan', () => {
  it('extracts the parent context and starts a span under it', () => {
    const fakeSpan = { __span: 'child' };
    mockTracerStartSpan.mockReturnValue(fakeSpan);

    const out = startChildSpan('child-op', { traceparent: 'tp' });

    expect(out).toBe(fakeSpan);
    expect(mockPropagationExtract).toHaveBeenCalledWith(ROOT_CONTEXT, {
      traceparent: 'tp',
    });
    expect(mockTracerStartSpan).toHaveBeenCalledWith(
      'child-op',
      {},
      mockExtractedCtx,
    );
  });
});

describe('startChildSpanWithContext', () => {
  it('returns both the span and a context that carries the span (for baggage propagation)', () => {
    const fakeSpan = { __span: 'child' };
    const ctxWithSpan = { __ctx: 'extracted+span' };
    mockTracerStartSpan.mockReturnValue(fakeSpan);
    mockTraceSetSpan.mockReturnValue(ctxWithSpan);

    const out = startChildSpanWithContext('op', { traceparent: 'tp' });

    expect(out.span).toBe(fakeSpan);
    expect(out.ctx).toBe(ctxWithSpan);
    // The new span is set onto the EXTRACTED parent ctx, not ROOT_CONTEXT —
    // this is what preserves W3C Baggage through to outgoing carriers.
    expect(mockTraceSetSpan).toHaveBeenCalledWith(mockExtractedCtx, fakeSpan);
  });
});

describe('startRootSpan', () => {
  it('starts a span with no parent context', () => {
    const fakeSpan = { __span: 'root' };
    mockTracerStartSpan.mockReturnValue(fakeSpan);

    const out = startRootSpan('boot');
    expect(out).toBe(fakeSpan);
    // No second/third arg → root span
    expect(mockTracerStartSpan).toHaveBeenCalledWith('boot');
  });
});

describe('injectCarrier', () => {
  it('builds a fresh carrier object and injects the span into it', () => {
    const span = { __span: 'x' };
    const ctxWithSpan = { __ctx: 'root+span' };
    mockTraceSetSpan.mockReturnValue(ctxWithSpan);
    // propagation.inject mutates the carrier; simulate that here.
    mockPropagationInject.mockImplementation(
      (_ctx: unknown, carrier: Record<string, string>) => {
        carrier['traceparent'] = '00-aa-bb-01';
      },
    );

    const out = injectCarrier(span as never);

    expect(mockTraceSetSpan).toHaveBeenCalledWith(ROOT_CONTEXT, span);
    expect(mockPropagationInject).toHaveBeenCalledWith(ctxWithSpan, {
      traceparent: '00-aa-bb-01',
    });
    expect(out).toEqual({ traceparent: '00-aa-bb-01' });
  });
});

describe('injectCarrierFromContext', () => {
  it('injects the full context (preserves baggage; does NOT setSpan again)', () => {
    const ctx = { __ctx: 'with-baggage+span' };
    mockPropagationInject.mockImplementation(
      (_ctx: unknown, carrier: Record<string, string>) => {
        carrier['traceparent'] = 'tp';
        carrier['baggage'] = 'tenant=acme';
      },
    );

    const out = injectCarrierFromContext(ctx as never);

    expect(out).toEqual({ traceparent: 'tp', baggage: 'tenant=acme' });
    // The whole point: we did NOT wrap with trace.setSpan(ROOT_CONTEXT, ...)
    expect(mockTraceSetSpan).not.toHaveBeenCalled();
  });
});

describe('initOtel', () => {
  let prevEnv: NodeJS.ProcessEnv;
  let registeredSigTerm: (() => void) | undefined;
  let registeredSigInt: (() => void) | undefined;
  let processOnceSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    prevEnv = { ...process.env };
    registeredSigTerm = undefined;
    registeredSigInt = undefined;
    processOnceSpy = jest
      .spyOn(process, 'once')
      .mockImplementation(
        (evt: string | symbol, cb: (...args: unknown[]) => void) => {
          if (evt === 'SIGTERM') registeredSigTerm = cb as () => void;
          if (evt === 'SIGINT') registeredSigInt = cb as () => void;
          return process;
        },
      );
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = prevEnv;
    processOnceSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    delete (process as { exitCode?: number }).exitCode;
  });

  it('honours OTEL_DIAG_LOG_LEVEL (uppercased) when it matches the table', () => {
    process.env.OTEL_DIAG_LOG_LEVEL = 'error';
    mockSdkStart.mockReturnValue(undefined);

    initOtel();

    expect(mockDiagSetLogger).toHaveBeenCalledTimes(1);
    // 2nd arg should be the ERROR level (mocked to 70 above)
    expect(mockDiagSetLogger.mock.calls[0][1]).toBe(70);
  });

  it('falls back to WARN-level diag logger when no env override AND NODE_ENV != production', () => {
    delete process.env.OTEL_DIAG_LOG_LEVEL;
    process.env.NODE_ENV = 'development';
    mockSdkStart.mockReturnValue(undefined);

    initOtel();

    expect(mockDiagSetLogger).toHaveBeenCalledTimes(1);
    expect(mockDiagSetLogger.mock.calls[0][1]).toBe(30); // WARN
  });

  it('does NOT install a diag logger in production with no explicit env override', () => {
    delete process.env.OTEL_DIAG_LOG_LEVEL;
    process.env.NODE_ENV = 'production';
    mockSdkStart.mockReturnValue(undefined);

    initOtel();

    expect(mockDiagSetLogger).not.toHaveBeenCalled();
  });

  it('ignores OTEL_DIAG_LOG_LEVEL values that are not in the allow-list', () => {
    process.env.OTEL_DIAG_LOG_LEVEL = 'VERBOSE'; // not WARN/ERROR/NONE
    process.env.NODE_ENV = 'development'; // forces the fallback path
    mockSdkStart.mockReturnValue(undefined);

    initOtel();

    // Only the WARN fallback was installed — VERBOSE was ignored.
    expect(mockDiagSetLogger).toHaveBeenCalledTimes(1);
    expect(mockDiagSetLogger.mock.calls[0][1]).toBe(30);
  });

  it('builds and starts a NodeSDK', () => {
    mockSdkStart.mockReturnValue(undefined);
    initOtel();
    expect(mockNodeSdkCtor).toHaveBeenCalledTimes(1);
    expect(mockSdkStart).toHaveBeenCalledTimes(1);
  });

  it('logs to console.error when sdk.start throws (does not rethrow)', () => {
    mockSdkStart.mockImplementation(() => {
      throw new Error('boot fail');
    });

    expect(() => initOtel()).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/OTel SDK failed to start.*boot fail/),
    );
  });

  it('logs a stringified non-Error throwable', () => {
    mockSdkStart.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'plain-string-error';
    });

    expect(() => initOtel()).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('plain-string-error'),
    );
  });

  it('registers SIGTERM and SIGINT shutdown handlers', () => {
    mockSdkStart.mockReturnValue(undefined);
    initOtel();
    const events = processOnceSpy.mock.calls.map((c) => c[0]);
    expect(events).toEqual(expect.arrayContaining(['SIGTERM', 'SIGINT']));
  });

  it('shutdown handler calls sdk.shutdown(); is idempotent on repeat signals', async () => {
    mockSdkStart.mockReturnValue(undefined);
    mockSdkShutdown.mockResolvedValue(undefined);
    initOtel();

    registeredSigTerm?.();
    registeredSigTerm?.(); // second signal should be a no-op
    // Allow the void Promise chain to settle.
    await new Promise((r) => setImmediate(r));

    expect(mockSdkShutdown).toHaveBeenCalledTimes(1);
  });

  it('on shutdown failure: logs to console.error and sets process.exitCode=1', async () => {
    mockSdkStart.mockReturnValue(undefined);
    mockSdkShutdown.mockRejectedValue(new Error('drain fail'));
    initOtel();

    registeredSigInt?.();
    await new Promise((r) => setImmediate(r));

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/OTel SDK failed to shutdown.*drain fail/),
    );
    expect(process.exitCode).toBe(1);
  });
});

// ─── series-diet config: metrics flag, views, instance identity ──────────────

describe('initOtel — metrics flag, views, service.instance.id', () => {
  let prevEnv: NodeJS.ProcessEnv;
  let processOnceSpy: jest.SpyInstance;

  beforeEach(() => {
    prevEnv = { ...process.env };
    processOnceSpy = jest
      .spyOn(process, 'once')
      .mockImplementation(() => process);
    mockSdkStart.mockReturnValue(undefined);
    mockNodeSdkCtor.mockClear();
  });

  afterEach(() => {
    process.env = prevEnv;
    processOnceSpy.mockRestore();
  });

  function sdkConfig(): Record<string, unknown> {
    return mockNodeSdkCtor.mock.calls[0][0] as Record<string, unknown>;
  }

  it('OTEL_METRICS_EXPORTER=none → no metricReader and no views', () => {
    process.env.OTEL_METRICS_EXPORTER = 'none';
    initOtel();
    expect(sdkConfig().metricReader).toBeUndefined();
    expect(sdkConfig().views).toBeUndefined();
  });

  it('default → metricReader present and the cardinality views wired in', () => {
    delete process.env.OTEL_METRICS_EXPORTER;
    initOtel();
    expect(sdkConfig().metricReader).toBeDefined();
    const views = sdkConfig().views as {
      instrumentName: string;
      aggregation?: { type: number };
    }[];
    const byName = Object.fromEntries(views.map((v) => [v.instrumentName, v]));
    // Drops (never queried anywhere):
    expect(byName['v8js.gc.duration'].aggregation).toEqual({ type: 0 });
    expect(byName['v8js.memory.heap.space.available_size'].aggregation).toEqual(
      { type: 0 },
    );
    // Kept-but-slimmed: pp keeps http.client.* (per-dependency latency is
    // the incident-diagnosis signal) with explicit slim boundaries.
    expect(byName['http.client.duration'].aggregation?.type).toBe(1);
    expect(byName['db.client.operation.duration'].aggregation?.type).toBe(1);
  });

  it('appends an env-qualified service.instance.id to OTEL_RESOURCE_ATTRIBUTES', () => {
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    delete process.env.SERVICE_INSTANCE_ID;
    process.env.OTEL_SERVICE_NAME = 'pp-sketch';
    process.env.ENV = 'staging';
    initOtel();
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'service.instance.id=pp-sketch-staging',
    );
  });

  it('SERVICE_INSTANCE_ID override wins and merges with existing attributes', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'foo=bar';
    process.env.SERVICE_INSTANCE_ID = 'replica-7';
    initOtel();
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'foo=bar,service.instance.id=replica-7',
    );
  });

  it('does not duplicate service.instance.id when the operator already set one', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'service.instance.id=custom';
    initOtel();
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'service.instance.id=custom',
    );
  });
});
