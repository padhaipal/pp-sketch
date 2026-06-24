const mockGetBaggage = jest.fn();
jest.mock('@opentelemetry/api', () => ({
  propagation: {
    getBaggage: (...a: unknown[]) => mockGetBaggage(...a),
  },
}));

import { BaggageSpanProcessor } from './baggage-span-processor';

function makeSpan(): { setAttribute: jest.Mock } {
  return { setAttribute: jest.fn() };
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
  mockGetBaggage.mockReset();
});

describe('BaggageSpanProcessor.onStart', () => {
  it('copies every configured baggage entry onto the span as an attribute', () => {
    mockGetBaggage.mockReturnValue(
      makeBaggage({
        'padhaipal.load_test': 'true',
        'padhaipal.test_phase': 'phase_1',
      }),
    );
    const span = makeSpan();
    const proc = new BaggageSpanProcessor([
      'padhaipal.load_test',
      'padhaipal.test_phase',
    ]);
    proc.onStart(span as never, 'parent-ctx' as never);
    expect(span.setAttribute).toHaveBeenCalledWith(
      'padhaipal.load_test',
      'true',
    );
    expect(span.setAttribute).toHaveBeenCalledWith(
      'padhaipal.test_phase',
      'phase_1',
    );
    expect(span.setAttribute).toHaveBeenCalledTimes(2);
  });

  it('no-op when baggage is absent (propagation.getBaggage returns undefined)', () => {
    mockGetBaggage.mockReturnValue(undefined);
    const span = makeSpan();
    const proc = new BaggageSpanProcessor(['padhaipal.load_test']);
    proc.onStart(span as never, 'ctx' as never);
    expect(span.setAttribute).not.toHaveBeenCalled();
  });

  it('skips entries that are not present in baggage', () => {
    mockGetBaggage.mockReturnValue(
      makeBaggage({ 'padhaipal.load_test': 'true' }),
    );
    const span = makeSpan();
    const proc = new BaggageSpanProcessor([
      'padhaipal.load_test',
      'padhaipal.test_phase',
    ]);
    proc.onStart(span as never, 'ctx' as never);
    expect(span.setAttribute).toHaveBeenCalledTimes(1);
    expect(span.setAttribute).toHaveBeenCalledWith(
      'padhaipal.load_test',
      'true',
    );
  });

  it('skips entries whose value is the empty string', () => {
    mockGetBaggage.mockReturnValue(makeBaggage({ 'padhaipal.load_test': '' }));
    const span = makeSpan();
    const proc = new BaggageSpanProcessor(['padhaipal.load_test']);
    proc.onStart(span as never, 'ctx' as never);
    expect(span.setAttribute).not.toHaveBeenCalled();
  });

  it('skips entries whose value is not a string', () => {
    mockGetBaggage.mockReturnValue({
      getEntry: () => ({ value: 42 as unknown as string }),
    });
    const span = makeSpan();
    const proc = new BaggageSpanProcessor(['padhaipal.load_test']);
    proc.onStart(span as never, 'ctx' as never);
    expect(span.setAttribute).not.toHaveBeenCalled();
  });
});

describe('BaggageSpanProcessor — passthrough hooks', () => {
  it('onEnd is a no-op', () => {
    const proc = new BaggageSpanProcessor([]);
    expect(() => proc.onEnd({} as never)).not.toThrow();
  });

  it('forceFlush + shutdown resolve to undefined', async () => {
    const proc = new BaggageSpanProcessor([]);
    await expect(proc.forceFlush()).resolves.toBeUndefined();
    await expect(proc.shutdown()).resolves.toBeUndefined();
  });
});
