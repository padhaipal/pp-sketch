This file is used by main.ts to initialize OTel SDK for this repository.
OTel data is exported to a separate Railway service running Grafana Alloy.
Alloy forwards OTel data to Grafana Cloud.

The following environment variables are available in .env:
* OTEL_SERVICE_NAME
* OTEL_EXPORTER_OTLP_ENDPOINT
* OTEL_TRACES_EXPORTER
* OTEL_METRICS_EXPORTER
* OTEL_LOGS_EXPORTER
* OTEL_RESOURCE_ATTRIBUTES
* OTEL_EXPORTER_OTLP_PROTOCOL

## Trace propagation pattern

Uses the W3C Trace Context propagation format (`traceparent`/`tracestate` headers) via `@opentelemetry/api`.

### Helpers (exported from this module)

* `extractSpan(carrier: Record<string, string>): Context` — calls `propagation.extract(ROOT_CONTEXT, carrier)`. Returns an OTel Context with the remote span as parent.
* `startChildSpan(name: string, carrier: Record<string, string>): Span` — calls `extractSpan(carrier)` then `tracer.startSpan(name, {}, parentCtx)`. Returns the new child Span.
* `injectCarrier(span: Span): Record<string, string>` — creates an empty carrier object, calls `propagation.inject(trace.setSpan(ROOT_CONTEXT, span), carrier)`, returns the carrier. This is the carrier that should be passed downstream.
* `startRootSpan(name: string): Span` — starts a new root span with no parent (for flows without an incoming carrier, e.g. HeyGen webhooks, dashboard requests).

### Controller → BullMQ → Processor propagation

1. **Controller** receives an HTTP request.
   * If the request body contains an OTel carrier (e.g. `body.otel.carrier`), call `startChildSpan(name, body.otel.carrier)` to create a child span.
   * If no incoming carrier exists (e.g. external webhook, dashboard), call `startRootSpan(name)`.
   * Call `injectCarrier(span)` to produce a fresh carrier.
   * Include the fresh carrier in the BullMQ job payload (`otel_carrier` field) before enqueuing.
   * End the span after enqueue succeeds (or on error).

2. **Processor** dequeues a job.
   * Extract `otel_carrier` from the job payload.
   * Call `startChildSpan(name, otel_carrier)` to create a child span.
   * Use this span for all log correlation within the job.
   * When making outbound HTTP calls that accept an `otel_carrier` parameter, call `injectCarrier(span)` and pass the result.
   * When enqueuing downstream BullMQ jobs, include `injectCarrier(span)` as the `otel_carrier` field.
   * End the span when the job completes or fails.
