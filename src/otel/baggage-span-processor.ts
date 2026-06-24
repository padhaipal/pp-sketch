import type { Context, Span } from '@opentelemetry/api';
import { propagation } from '@opentelemetry/api';
import type {
  ReadableSpan,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// Copies a configured set of baggage entries onto every started span as
// span attributes, so they show up as queryable fields in Tempo (W3C
// Baggage propagates through context but does NOT automatically appear on
// spans). Required for filtering traces by load_test / test_phase / any
// other domain tag set upstream.
export class BaggageSpanProcessor implements SpanProcessor {
  constructor(private readonly entryKeys: readonly string[]) {}

  onStart(span: Span, parentContext: Context): void {
    const baggage = propagation.getBaggage(parentContext);
    if (!baggage) return;
    for (const key of this.entryKeys) {
      const value = baggage.getEntry(key)?.value;
      if (typeof value === 'string' && value.length > 0) {
        span.setAttribute(key, value);
      }
    }
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
