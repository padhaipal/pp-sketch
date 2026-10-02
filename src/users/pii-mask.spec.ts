import { maskPii, visibilityOf } from './pii-mask';

describe('maskPii', () => {
  it('keeps the first and last character with "..." between', () => {
    expect(maskPii('Rani')).toBe('R...i');
    expect(maskPii('Rani Devi')).toBe('R...i');
    expect(maskPii('919876543210')).toBe('9...0');
  });

  it('one- and two-character values follow the same rule (A → A...A, AB → A...B)', () => {
    expect(maskPii('A')).toBe('A...A');
    expect(maskPii('AB')).toBe('A...B');
  });

  it('counts code points, so Devanagari and emoji are not split', () => {
    expect(maskPii('राधा')).toBe('र...ा');
    expect(maskPii('😀x😁')).toBe('😀...😁');
  });

  it('ignores surrounding whitespace; null and blank pass through', () => {
    expect(maskPii('  Rani  ')).toBe('R...i');
    expect(maskPii(null)).toBeNull();
    expect(maskPii('')).toBe('');
    expect(maskPii('   ')).toBe('   ');
  });

  it('visibilityOf', () => {
    expect(visibilityOf(true)).toBe('full');
    expect(visibilityOf(false)).toBe('masked');
  });
});
