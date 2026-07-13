import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  propagation,
  trace,
  Span,
  Context,
  ROOT_CONTEXT,
} from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  AggregationType,
  createAllowListAttributesProcessor,
  PeriodicExportingMetricReader,
  type ViewOptions,
} from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { OtelCarrier } from './otel.dto';
import { BaggageSpanProcessor } from './baggage-span-processor';
import { PROPAGATED_BAGGAGE_KEYS } from './baggage-keys';

export const tracer = trace.getTracer(process.env.OTEL_SERVICE_NAME ?? 'pp');

const diagLevelMap: Record<string, DiagLogLevel> = {
  WARN: DiagLogLevel.WARN,
  ERROR: DiagLogLevel.ERROR,
  NONE: DiagLogLevel.NONE,
};

// Cardinality diet against Grafana Cloud's 10k free-tier active-series cap.
// Unlike wabot, pp KEEPS http.client.* — its clients are the real
// dependencies (STT / LLM / HeyGen / wabot), and per-dependency latency
// aggregates are what diagnosed the 2026-07-13 staging timeout incident.
// Buckets are slimmed instead; boundaries cover the 20s+ tail external
// APIs exhibit. Dropped families were never queried anywhere:
// v8js.gc.duration and the per-heap-space breakdowns (totals kept,
// attributes collapsed).
const metricViews: ViewOptions[] = [
  {
    instrumentName: 'v8js.gc.duration',
    aggregation: { type: AggregationType.DROP },
  },
  {
    instrumentName: 'v8js.memory.heap.space.available_size',
    aggregation: { type: AggregationType.DROP },
  },
  {
    instrumentName: 'v8js.memory.heap.space.physical_size',
    aggregation: { type: AggregationType.DROP },
  },
  {
    instrumentName: 'v8js.memory.heap.used',
    attributesProcessors: [createAllowListAttributesProcessor([])],
  },
  {
    instrumentName: 'v8js.memory.heap.limit',
    attributesProcessors: [createAllowListAttributesProcessor([])],
  },
  {
    // old-semconv ms histogram (undici + http instrumentations emit both
    // generations; keep both, slim both).
    instrumentName: 'http.client.duration',
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: {
        boundaries: [25, 100, 250, 1000, 2500, 5000, 10000, 30000],
      },
    },
  },
  {
    // new-semconv seconds histogram.
    instrumentName: 'http.client.request.duration',
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: [0.025, 0.1, 0.25, 1, 2.5, 5, 10, 30] },
    },
  },
  {
    instrumentName: 'http.server.duration',
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: [10, 50, 100, 250, 500, 1000, 2500, 10000] },
    },
  },
  {
    instrumentName: 'db.client.operation.duration',
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 10] },
    },
  },
];

export function initOtel(): NodeSDK {
  const configuredDiagLevel = process.env.OTEL_DIAG_LOG_LEVEL?.toUpperCase();
  if (configuredDiagLevel && diagLevelMap[configuredDiagLevel] !== undefined) {
    diag.setLogger(new DiagConsoleLogger(), diagLevelMap[configuredDiagLevel]);
  } else if (process.env.NODE_ENV !== 'production') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

  // CompositePropagator carries W3C baggage (padhaipal.load_test,
  // padhaipal.test_phase) across HTTP + queue boundaries alongside the
  // trace context. NodeSDK's default propagator only handles trace
  // context — without the baggage propagator added explicitly, pp-sketch
  // would never see the load_test label on its own metrics.
  const textMapPropagator = new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  });

  // Honor the standard OTEL_METRICS_EXPORTER=none (previously inert because
  // the exporter is constructed explicitly). Staging sets it: staging
  // metrics only existed for load-test judgment, which the post-merge gate
  // now does artillery-side, and every staging redeploy otherwise strands a
  // duplicate series set against Grafana Cloud's free-tier cap.
  const metricsDisabled = process.env.OTEL_METRICS_EXPORTER === 'none';

  // Series-identity control: metric series identity in Grafana Cloud is
  // service.name + service.instance.id, and the SDK default instance id is
  // a random UUID per process — every redeploy strands a full duplicate
  // series set until it ages out. A constant, ENVIRONMENT-QUALIFIED id
  // keeps series continuous across deploys (deployment_environment is NOT
  // part of metric identity, so the env must be baked into the id or
  // staging and production would write into the same series and corrupt
  // each other).
  // ⚠️ Single-replica assumption: if this service ever runs >1 replica,
  // set SERVICE_INSTANCE_ID per-replica (e.g. $RAILWAY_REPLICA_ID) — two
  // replicas writing one series id silently corrupt every counter.
  const serviceInstanceId =
    process.env.SERVICE_INSTANCE_ID ??
    `${process.env.OTEL_SERVICE_NAME ?? 'pp-sketch'}-${process.env.ENV ?? 'development'}`;
  if (!process.env.OTEL_RESOURCE_ATTRIBUTES?.includes('service.instance.id=')) {
    process.env.OTEL_RESOURCE_ATTRIBUTES = [
      process.env.OTEL_RESOURCE_ATTRIBUTES,
      `service.instance.id=${serviceInstanceId}`,
    ]
      .filter(Boolean)
      .join(',');
  }

  // BaggageSpanProcessor first so padhaipal.* baggage entries land on each
  // span as attributes before BatchSpanProcessor batches/exports the span.
  const sdk = new NodeSDK({
    textMapPropagator,
    spanProcessors: [
      new BaggageSpanProcessor(PROPAGATED_BAGGAGE_KEYS),
      new BatchSpanProcessor(new OTLPTraceExporter()),
    ],
    ...(metricsDisabled
      ? {}
      : {
          metricReader: new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter(),
          }),
          views: metricViews,
        }),
    logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
    // UndiciInstrumentation covers Node 18+'s global fetch (used by both
    // services for cross-process HTTP calls). The default
    // auto-instrumentation bundle only hooks the legacy http/https
    // modules, missing all fetch traffic.
    instrumentations: [
      getNodeAutoInstrumentations(),
      new UndiciInstrumentation(),
    ],
  });

  try {
    sdk.start();
  } catch (error: unknown) {
    const details =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    console.error(`OTel SDK failed to start: ${details}`);
  }

  let shutdownStarted = false;
  const shutdown = (): void => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;

    void sdk.shutdown().catch((error: unknown) => {
      const details =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      console.error(`OTel SDK failed to shutdown: ${details}`);
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return sdk;
}

export function extractSpan(carrier: OtelCarrier): Context {
  return propagation.extract(ROOT_CONTEXT, carrier);
}

export function startChildSpan(name: string, carrier: OtelCarrier): Span {
  const parentCtx = extractSpan(carrier);
  return tracer.startSpan(name, {}, parentCtx);
}

/**
 * Like startChildSpan() but returns both the span AND a Context that preserves
 * baggage (and any other context entries) from the incoming carrier, in addition
 * to setting the new child span on that context. Use this when the carrier may
 * contain W3C Baggage that needs to flow through to downstream services —
 * observability metadata, tenant IDs, feature flags, etc.
 */
export function startChildSpanWithContext(
  name: string,
  carrier: OtelCarrier,
): { span: Span; ctx: Context } {
  const parentCtx = extractSpan(carrier);
  const span = tracer.startSpan(name, {}, parentCtx);
  const ctx = trace.setSpan(parentCtx, span);
  return { span, ctx };
}

export function startRootSpan(name: string): Span {
  return tracer.startSpan(name);
}

export function injectCarrier(span: Span): OtelCarrier {
  const carrier: OtelCarrier = {};
  propagation.inject(trace.setSpan(ROOT_CONTEXT, span), carrier);
  return carrier;
}

/**
 * Like injectCarrier() but takes a full Context (not just a Span) so that
 * any baggage attached to that context is preserved in the outgoing carrier.
 * Pair with startChildSpanWithContext() on the receiving end to keep W3C
 * Baggage flowing through the entire call chain.
 */
export function injectCarrierFromContext(ctx: Context): OtelCarrier {
  const carrier: OtelCarrier = {};
  propagation.inject(ctx, carrier);
  return carrier;
}
