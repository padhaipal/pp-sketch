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

export function startRootSpan(name: string): Span {
  return tracer.startSpan(name);
}

export function injectCarrier(span: Span): OtelCarrier {
  const carrier: OtelCarrier = {};
  propagation.inject(trace.setSpan(ROOT_CONTEXT, span), carrier);
  return carrier;
}
