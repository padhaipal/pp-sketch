// Unit tests for isLoadTestCarrier. Verifies the helper returns true only
// when the propagated W3C Baggage carries padhaipal.load_test === 'true',
// and returns false for every "let it pass" case (no carrier, no baggage,
// no entry, value 'false', value of any other string).

const mockGetBaggage = jest.fn();
const mockExtract = jest.fn();
jest.mock('@opentelemetry/api', () => ({
  context: { active: jest.fn().mockReturnValue('active-ctx') },
  propagation: {
    extract: (...args: unknown[]) => mockExtract(...args),
    getBaggage: (...args: unknown[]) => mockGetBaggage(...args),
  },
}));

import { isLoadTestCarrier } from './load-test-context';
import type { OtelCarrier } from './otel.dto';

const CARRIER = { traceparent: 'tp' } as OtelCarrier;

beforeEach(() => {
  mockExtract.mockReset().mockReturnValue('extracted-ctx');
  mockGetBaggage.mockReset();
});

describe('isLoadTestCarrier', () => {
  it('returns true when baggage padhaipal.load_test entry value is exactly "true"', () => {
    mockGetBaggage.mockReturnValue({
      getEntry: (k: string) =>
        k === 'padhaipal.load_test' ? { value: 'true' } : undefined,
    });
    expect(isLoadTestCarrier(CARRIER)).toBe(true);
    expect(mockExtract).toHaveBeenCalledWith('active-ctx', CARRIER);
  });

  it('returns false when baggage padhaipal.load_test entry value is "false"', () => {
    mockGetBaggage.mockReturnValue({
      getEntry: () => ({ value: 'false' }),
    });
    expect(isLoadTestCarrier(CARRIER)).toBe(false);
  });

  it('returns false when baggage padhaipal.load_test entry value is any other string', () => {
    mockGetBaggage.mockReturnValue({
      getEntry: () => ({ value: 'TRUE' }), // capitalised → not a match
    });
    expect(isLoadTestCarrier(CARRIER)).toBe(false);
  });

  it('returns false when baggage has no padhaipal.load_test entry', () => {
    mockGetBaggage.mockReturnValue({
      getEntry: () => undefined,
    });
    expect(isLoadTestCarrier(CARRIER)).toBe(false);
  });

  it('returns false when extracted context carries no baggage at all', () => {
    mockGetBaggage.mockReturnValue(undefined);
    expect(isLoadTestCarrier(CARRIER)).toBe(false);
  });

  it('returns false (without calling propagation) when carrier is undefined', () => {
    expect(isLoadTestCarrier(undefined)).toBe(false);
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockGetBaggage).not.toHaveBeenCalled();
  });
});
