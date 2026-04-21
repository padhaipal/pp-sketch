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
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { OtelCarrier } from './otel.dto';

export const tracer = trace.getTracer(process.env.OTEL_SERVICE_NAME ?? 'pp');

const diagLevelMap: Record<string, DiagLogLevel> = {
  WARN: DiagLogLevel.WARN,
  ERROR: DiagLogLevel.ERROR,
  NONE: DiagLogLevel.NONE,
};

export function initOtel(): NodeSDK {
  const configuredDiagLevel = process.env.OTEL_DIAG_LOG_LEVEL?.toUpperCase();
  if (
    configuredDiagLevel &&
    diagLevelMap[configuredDiagLevel] !== undefined
  ) {
    diag.setLogger(new DiagConsoleLogger(), diagLevelMap[configuredDiagLevel]);
  } else if (process.env.NODE_ENV !== 'production') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
    }),
    logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
    instrumentations: [getNodeAutoInstrumentations()],
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
