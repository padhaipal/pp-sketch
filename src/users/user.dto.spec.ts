// Unit tests for partitionUserIdentifiers — splits a list of user identifiers
// into uuids and normalized E.164 external_ids, with one BadRequestException
// listing all bad items.

// uuid is ESM-only — provide a CJS-shaped mock. validate uses the loose
// hex-shape regex (no version/variant nibble checks) so test fixtures with
// arbitrary hex bytes still classify as uuids.
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'gen-uuid'),
  validate: (s: unknown): boolean =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));

import { BadRequestException } from '@nestjs/common';
import { partitionUserIdentifiers } from './user.dto';

const UUID = '11111111-2222-3333-4444-555555555555';
const UUID2 = '22222222-3333-4444-5555-666666666666';

describe('partitionUserIdentifiers', () => {
  it('routes uuid-shaped inputs into ids and E.164 inputs into externalIds', () => {
    const out = partitionUserIdentifiers([UUID, '919999990001']);
    expect(out.ids).toEqual([UUID]);
    expect(out.externalIds).toEqual(['919999990001']);
  });

  it('normalizes E.164 inputs (strips +, trims, collapses spaces)', () => {
    const out = partitionUserIdentifiers(['+91 999 999 0001']);
    expect(out.externalIds).toEqual(['919999990001']);
  });

  it('returns canonical[] aligned with inputs (uuid passthrough, E.164 normalized)', () => {
    const out = partitionUserIdentifiers([
      UUID,
      '+91 999 999 0001',
      '919999990002',
    ]);
    expect(out.canonical).toEqual([UUID, '919999990001', '919999990002']);
  });

  it('preserves input order in canonical even when uuids and phones interleave', () => {
    const out = partitionUserIdentifiers(['919999990001', UUID, '919999990002']);
    expect(out.canonical).toEqual(['919999990001', UUID, '919999990002']);
    expect(out.ids).toEqual([UUID]);
    expect(out.externalIds).toEqual(['919999990001', '919999990002']);
  });

  it('trims whitespace before classifying', () => {
    const out = partitionUserIdentifiers([`  ${UUID}  `, '  919999990001  ']);
    expect(out.ids).toEqual([UUID]);
    expect(out.externalIds).toEqual(['919999990001']);
  });

  it('returns empty buckets for an empty input array (does not throw)', () => {
    expect(partitionUserIdentifiers([])).toEqual({
      ids: [],
      externalIds: [],
      canonical: [],
    });
  });

  it('throws BadRequestException on a single malformed identifier', () => {
    expect(() => partitionUserIdentifiers(['not-a-uuid-not-a-phone'])).toThrow(
      BadRequestException,
    );
  });

  it('collects all bad items into one error message (not first-bad-and-stop)', () => {
    try {
      partitionUserIdentifiers(['garbage-1', UUID, 'garbage-2', 'garbage-3']);
      fail('expected BadRequestException');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const msg = (e as Error).message;
      expect(msg).toContain('garbage-1');
      expect(msg).toContain('garbage-2');
      expect(msg).toContain('garbage-3');
    }
  });

  it('flags empty/whitespace-only strings as bad (rendered as <empty>)', () => {
    expect(() => partitionUserIdentifiers([''])).toThrow(/<empty>/);
    expect(() => partitionUserIdentifiers(['   '])).toThrow(/<empty>/);
  });

  it('error message prefix names the failure class (not uuid or E.164)', () => {
    expect(() => partitionUserIdentifiers(['bogus'])).toThrow(
      /invalid identifiers \(not a uuid or E\.164 phone\)/,
    );
  });

  it('handles mixed valid + invalid: throws once listing only the invalid items', () => {
    try {
      partitionUserIdentifiers([UUID, '919999990001', 'bogus-1', UUID2]);
      fail('expected BadRequestException');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('bogus-1');
      expect(msg).not.toContain(UUID);
      expect(msg).not.toContain('919999990001');
      expect(msg).not.toContain(UUID2);
    }
  });
});
