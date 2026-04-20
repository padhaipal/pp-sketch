import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import {
  context,
  propagation,
  trace,
  Span,
  Context,
  ROOT_CONTEXT,
} from '@opentelemetry/api';
import type { OtelCarrier } from './otel.dto';

const tracer = trace.getTracer(process.env.OTEL_SERVICE_NAME ?? 'pp');

export function initOtel(): NodeSDK {
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  return sdk;
}

export function extractSpan(carrier: OtelCarrier): Context {
  return propagation.extract(ROOT_CONTEXT, carrier);
}

export function startChildSpan(
  name: string,
  carrier: OtelCarrier,
): Span {
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
