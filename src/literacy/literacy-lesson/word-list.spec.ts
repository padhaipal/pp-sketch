import * as fs from 'fs';
import * as path from 'path';

describe('word-list.json', () => {
  it('is a non-empty array of non-empty strings', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, 'word-list.json'),
      'utf-8',
    );
    const parsed: unknown = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as unknown[];
    expect(arr.length).toBeGreaterThan(0);
    expect(arr.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
  });
});
