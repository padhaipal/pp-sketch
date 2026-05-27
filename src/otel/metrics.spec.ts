// The metrics module only does module-load setup: get a Meter and define
// one histogram. Coverage just needs the module to load, but we also want
// to pin down the histogram's identity so future renames / unit drift fail
// loudly.

const mockHistogram = { record: jest.fn() };
const mockCreateHistogram = jest.fn(() => mockHistogram);
const mockGetMeter = jest.fn(() => ({ createHistogram: mockCreateHistogram }));

jest.mock('@opentelemetry/api', () => ({
  metrics: { getMeter: (...args: unknown[]) => mockGetMeter(...args) },
}));

import { wabotInboundJobDuration } from './metrics';

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
    // Range sanity: spans from low-ms to a minute. Dropping the high end
    // would silently lump everything >10s into the +Inf bucket.
    expect(buckets[0]).toBeLessThanOrEqual(10);
    expect(buckets[buckets.length - 1]).toBeGreaterThanOrEqual(30_000);
  });

  it('exports the histogram instance returned by createHistogram', () => {
    expect(wabotInboundJobDuration).toBe(mockHistogram);
  });
});
