// pii.ts caches the HMAC key on first call. Each test below uses
// jest.isolateModules() so the cache and the env-var assertion run fresh
// per case.

describe('toLogId / getKey', () => {
  const VALID_KEY_HEX = '0'.repeat(64); // 32 bytes
  const SHORT_KEY_HEX = '0'.repeat(40); // 20 bytes (< 32 required)

  afterEach(() => {
    delete process.env.LOG_PII_HMAC_KEY;
  });

  it('throws on first call when LOG_PII_HMAC_KEY is unset', () => {
    delete process.env.LOG_PII_HMAC_KEY;
    jest.isolateModules(() => {
      const { toLogId } = require('./pii');
      expect(() => toLogId('919999990001')).toThrow(
        /LOG_PII_HMAC_KEY environment variable is required/,
      );
    });
  });

  it('throws when the key is shorter than 32 bytes', () => {
    process.env.LOG_PII_HMAC_KEY = SHORT_KEY_HEX;
    jest.isolateModules(() => {
      const { toLogId } = require('./pii');
      expect(() => toLogId('919999990001')).toThrow(
        /must be a hex-encoded key of at least 32 bytes/,
      );
    });
  });

  it('returns a "u_" prefixed 12-char token for a valid key', () => {
    process.env.LOG_PII_HMAC_KEY = VALID_KEY_HEX;
    jest.isolateModules(() => {
      const { toLogId } = require('./pii');
      const tok = toLogId('919999990001') as string;
      expect(tok).toMatch(/^u_[0-9a-f]{10}$/);
    });
  });

  it('is deterministic: the same input always maps to the same token', () => {
    process.env.LOG_PII_HMAC_KEY = VALID_KEY_HEX;
    jest.isolateModules(() => {
      const { toLogId } = require('./pii');
      expect(toLogId('919999990001')).toBe(toLogId('919999990001'));
    });
  });

  it('different inputs produce different tokens (no trivial collisions in this sample)', () => {
    process.env.LOG_PII_HMAC_KEY = VALID_KEY_HEX;
    jest.isolateModules(() => {
      const { toLogId } = require('./pii');
      const inputs = [
        '919999990001',
        '919999990002',
        '918888880001',
        '12025550100',
      ];
      const tokens = new Set(inputs.map((i) => toLogId(i)));
      expect(tokens.size).toBe(inputs.length);
    });
  });

  it('caches the key: a second call with the env var removed still works', () => {
    process.env.LOG_PII_HMAC_KEY = VALID_KEY_HEX;
    jest.isolateModules(() => {
      const { toLogId } = require('./pii');
      toLogId('warm-cache'); // first call caches
      delete process.env.LOG_PII_HMAC_KEY;
      expect(() => toLogId('after-unset')).not.toThrow();
    });
  });
});
