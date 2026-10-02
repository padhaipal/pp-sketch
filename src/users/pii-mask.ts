// How personal data looks to a viewer who is not directly above its owner in
// the hierarchy (see PiiAccessService). `full` = as stored; `masked` = first
// and last character with "..." between, so a name or phone number stays
// recognisable to the person it belongs to without identifying them to
// anyone else: "Rani" → "R...i", "A" → "A...A", "AB" → "A...B",
// "919876543210" → "9...0".
export type PiiVisibility = 'full' | 'masked';

export const MASK_SEPARATOR = '...';

export function maskPii(value: string): string;
export function maskPii(value: string | null): string | null;
export function maskPii(value: string | null): string | null {
  if (value === null) return null;
  // Code points, not UTF-16 units: a Devanagari name must not split a
  // surrogate pair or a combining mark from its base.
  const chars = Array.from(value.trim());
  if (chars.length === 0) return value;
  return `${chars[0]}${MASK_SEPARATOR}${chars[chars.length - 1]}`;
}

export const visibilityOf = (visible: boolean): PiiVisibility =>
  visible ? 'full' : 'masked';
