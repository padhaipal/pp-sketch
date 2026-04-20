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

Uses the W3C Trace Context propagation format (`traceparent`/`tracestate` headers) via `@opentelemetry/api`. The composite propagator also carries W3C Baggage (`baggage` header) for business-context key/value pairs that must ride along with the trace (e.g. `wabot.msg.ts_ms` set by wabot to enable true user-perceived delivery latency on the return leg).

### Helpers (exported from this module)

* `extractSpan(carrier: Record<string, string>): Context` — calls `propagation.extract(ROOT_CONTEXT, carrier)`. Returns an OTel Context with the remote span as parent (plus any baggage from the carrier).
* `startChildSpan(name: string, carrier: Record<string, string>): Span` — calls `extractSpan(carrier)` then `tracer.startSpan(name, {}, parentCtx)`. Returns the new child Span. **Baggage-hostile:** only the Span is returned, the enclosing Context (which holds the baggage) is dropped. Use when you only care about trace linkage and do NOT need baggage to flow onwards.
* `startChildSpanWithContext(name: string, carrier: Record<string, string>): { span: Span, ctx: Context }` — like `startChildSpan()` but also returns a Context that preserves the baggage from the carrier plus the new child span. Use this when downstream calls need to propagate baggage (e.g. outbound HTTP calls back to wabot).
* `injectCarrier(span: Span): Record<string, string>` — creates an empty carrier, calls `propagation.inject(trace.setSpan(ROOT_CONTEXT, span), carrier)`, returns the carrier. **Baggage-stripping:** because it injects from `ROOT_CONTEXT`, any baggage on the caller's active context is dropped. Use only for purely internal pp-sketch fan-out where baggage does not need to continue.
* `injectCarrierFromContext(ctx: Context): Record<string, string>` — like `injectCarrier()` but takes a full Context (from `startChildSpanWithContext`) so baggage attached to that context is preserved in the outgoing carrier. Pair with `startChildSpanWithContext` on the receiving end to keep W3C Baggage flowing through the entire call chain.
* `startRootSpan(name: string): Span` — starts a new root span with no parent (for flows without an incoming carrier, e.g. HeyGen webhooks, dashboard requests).

### Controller → BullMQ → Processor propagation

1. **Controller** receives an HTTP request.
   * If the request body contains an OTel carrier (e.g. `body.otel.carrier`), call `startChildSpanWithContext(name, body.otel.carrier)` to get both a child span and a baggage-preserving ctx. (Use `startChildSpan(...)` only if you are certain no baggage needs to flow onwards.)
   * If no incoming carrier exists (e.g. external webhook, dashboard), call `startRootSpan(name)`.
   * Call `injectCarrierFromContext(ctx)` (or `injectCarrier(span)` if baggage is irrelevant) to produce a fresh carrier.
   * Include the fresh carrier in the BullMQ job payload (`otel_carrier` field) before enqueuing.
   * End the span after enqueue succeeds (or on error).

2. **Processor** dequeues a job.
   * Extract `otel_carrier` from the job payload.
   * Call `startChildSpanWithContext(name, otel_carrier)` to create a child span and preserve any baggage from the carrier (important for the wabot-inbound processor because it makes outbound HTTP calls back to wabot, which reads `wabot.msg.ts_ms` from baggage to record delivery latency).
   * Use this span for all log correlation within the job.
   * When making outbound HTTP calls that accept an `otel_carrier` parameter AND go back to wabot (or anywhere else that reads baggage), call `injectCarrierFromContext(ctx)` and pass the result.
   * When making internal pp-sketch outbound calls or enqueuing internal pp-sketch jobs where baggage is not needed, `injectCarrier(span)` is still fine (and keeps carriers smaller).
   * End the span when the job completes or fails.
