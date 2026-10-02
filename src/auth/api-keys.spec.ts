import {
  API_CALLERS,
  API_KEY_ENV,
  assertApiKeyEnv,
  authenticateApiKey,
  readApiKeys,
} from './api-keys';

const env = (over: Record<string, string | undefined>) =>
  ({ ...over }) as NodeJS.ProcessEnv;

describe('readApiKeys', () => {
  it('reads one key per caller from its env var, skipping unset and empty ones', () => {
    const keys = readApiKeys(
      env({ DASHBOARD_API_KEY: 'dash-secret', WABOT_INBOUND_API_KEY: '' }),
    );
    expect([...keys.keys()]).toEqual(['dashboard']);
    expect(keys.get('dashboard')?.toString()).toBe('dash-secret');
    expect(readApiKeys(env({})).size).toBe(0);
  });

  it('names every caller in API_KEY_ENV', () => {
    for (const caller of API_CALLERS)
      expect(API_KEY_ENV[caller]).toMatch(/_API_KEY$/);
  });
});

describe('assertApiKeyEnv', () => {
  it('throws, naming both vars, when no caller has a key', () => {
    expect(() => assertApiKeyEnv(env({}))).toThrow(
      /DASHBOARD_API_KEY and WABOT_INBOUND_API_KEY/,
    );
  });

  it('passes when at least one caller has a key', () => {
    expect(() =>
      assertApiKeyEnv(env({ WABOT_INBOUND_API_KEY: 'w' })),
    ).not.toThrow();
  });
});

describe('authenticateApiKey', () => {
  const keys = readApiKeys(
    env({
      DASHBOARD_API_KEY: 'dash-secret',
      WABOT_INBOUND_API_KEY: 'wabot-key',
    }),
  );

  it('rejects a missing, empty or non-string key as missing', () => {
    for (const provided of [undefined, '', 42, ['dash-secret']]) {
      expect(authenticateApiKey(provided, '/users', keys)).toEqual({
        ok: false,
        reason: 'missing',
      });
    }
  });

  it('rejects a wrong key — including a prefix, a longer string and a different case — as invalid', () => {
    for (const provided of ['dash', 'dash-secret!', 'DASH-SECRET', 'nope']) {
      expect(authenticateApiKey(provided, '/users', keys)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
  });

  it('identifies the caller by its key; the dashboard may reach any route', () => {
    for (const path of ['/users/abc', '/wabot/inbound', '/admin/mirror']) {
      expect(authenticateApiKey('dash-secret', path, keys)).toEqual({
        ok: true,
        caller: 'dashboard',
      });
    }
  });

  it("wabot's key opens only /wabot/inbound", () => {
    expect(authenticateApiKey('wabot-key', '/wabot/inbound', keys)).toEqual({
      ok: true,
      caller: 'wabot',
    });
    expect(authenticateApiKey('wabot-key', '/wabot/inbound/', keys).ok).toBe(
      true,
    );
    for (const path of ['/users/abc', '/wabot/inbound/extra', '/wabot']) {
      expect(authenticateApiKey('wabot-key', path, keys)).toEqual({
        ok: false,
        reason: 'forbidden_route',
      });
    }
  });

  it('with no keys configured every presented key is invalid (fail closed)', () => {
    expect(
      authenticateApiKey('dash-secret', '/users', readApiKeys(env({}))),
    ).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
