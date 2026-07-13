// The metrics module only does module-load setup: get a Meter and define
// one histogram. Coverage just needs the module to load, but we also want
// to pin down the histogram's identity so future renames / unit drift fail
// loudly.

const mockHistogram = { record: jest.fn() };
const mockCreateHistogram = jest.fn(() => mockHistogram);
const mockGetMeter = jest.fn(() => ({ createHistogram: mockCreateHistogram }));
const mockGetBaggage = jest.fn();
const mockContextActive = jest.fn().mockReturnValue('active-ctx');

jest.mock('@opentelemetry/api', () => ({
  metrics: { getMeter: (...args: unknown[]) => mockGetMeter(...args) },
  propagation: {
    getBaggage: (...a: unknown[]) => mockGetBaggage(...a),
  },
  context: {
    active: () => mockContextActive(),
  },
}));

import { buildJobAttributes, wabotInboundJobDuration } from './metrics';

function makeBaggage(entries: Record<string, string>): {
  getEntry: jest.Mock;
} {
  return {
    getEntry: jest.fn((key: string) =>
      key in entries ? { value: entries[key] } : undefined,
    ),
  };
}

describe('metrics module', () => {
  it('acquires the meter under the "pp" service name', () => {
    expect(mockGetMeter).toHaveBeenCalledWith('pp');
  });

  it('defines wabotInboundJobDuration with the documented name, unit, and bucket boundaries', () => {
    expect(mockCreateHistogram).toHaveBeenCalledTimes(1);
    const [name, options] = mockCreateHistogram.mock.calls[0] as [
      string,
      {
        description: string;
        unit: string;
        advice: { explicitBucketBoundaries: number[] };
      },
    ];

    expect(name).toBe('pp.wabot_inbound.job_duration_ms');
    expect(options.unit).toBe('ms');
    expect(options.description).toMatch(/wabot-inbound BullMQ job/i);

    // Buckets must be strictly increasing — a regression that shuffled them
    // would break the histogram bucket assignment.
    const buckets = options.advice.explicitBucketBoundaries;
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]).toBeGreaterThan(buckets[i - 1]);
    }
    // Range sanity: spans from double-digit ms (healthy p50 territory,
    // post series-diet) to a minute. Dropping the high end would silently
    // lump everything >10s into the +Inf bucket.
    expect(buckets[0]).toBeLessThanOrEqual(50);
    expect(buckets[buckets.length - 1]).toBeGreaterThanOrEqual(30_000);
  });

  it('exports the histogram instance returned by createHistogram', () => {
    expect(wabotInboundJobDuration).toBe(mockHistogram);
  });
});

describe('buildJobAttributes', () => {
  beforeEach(() => {
    mockGetBaggage.mockReset();
  });

  it('defaults load_test to "false" when no baggage exists', () => {
    mockGetBaggage.mockReturnValue(undefined);
    expect(buildJobAttributes('success')).toEqual({
      outcome: 'success',
      load_test: 'false',
    });
  });

  it('reads padhaipal.load_test=true from baggage when present', () => {
    mockGetBaggage.mockReturnValue(
      makeBaggage({ 'padhaipal.load_test': 'true' }),
    );
    expect(buildJobAttributes('success')).toEqual({
      outcome: 'success',
      load_test: 'true',
    });
  });

  it('includes test_phase when set in baggage', () => {
    mockGetBaggage.mockReturnValue(
      makeBaggage({
        'padhaipal.load_test': 'true',
        'padhaipal.test_phase': 'phase_2',
      }),
    );
    expect(buildJobAttributes('skipped')).toEqual({
      outcome: 'skipped',
      load_test: 'true',
      test_phase: 'phase_2',
    });
  });

  it('omits test_phase when its baggage value is the empty string', () => {
    mockGetBaggage.mockReturnValue(
      makeBaggage({
        'padhaipal.load_test': 'false',
        'padhaipal.test_phase': '',
      }),
    );
    const attrs = buildJobAttributes('success');
    expect(attrs.test_phase).toBeUndefined();
    expect(attrs.load_test).toBe('false');
  });

  it('preserves each outcome literal exactly', () => {
    mockGetBaggage.mockReturnValue(undefined);
    for (const o of ['success', 'skipped', 'error'] as const) {
      expect(buildJobAttributes(o).outcome).toBe(o);
    }
  });

  it('reads from the active OTel context', () => {
    mockGetBaggage.mockReturnValue(undefined);
    buildJobAttributes('success');
    expect(mockGetBaggage).toHaveBeenLastCalledWith('active-ctx');
  });
});
