import { timingSafeEqual } from 'node:crypto';

// Every HTTP route on pp-sketch is behind a shared-secret "badge" (ApiKeyGuard)
// unless marked @Public(). Each caller has its own key so one can be rotated
// without touching the other and so a rejected request names its caller.
export const API_CALLERS = ['dashboard', 'wabot'] as const;
export type ApiCaller = (typeof API_CALLERS)[number];

export const API_KEY_HEADER = 'x-api-key';

// Env var holding each caller's key. A caller whose var is unset or empty
// cannot authenticate at all (fail closed).
export const API_KEY_ENV: Readonly<Record<ApiCaller, string>> = {
  dashboard: 'DASHBOARD_API_KEY',
  wabot: 'WABOT_INBOUND_API_KEY',
};

// Routes a caller may reach. `null` = everything that is not @Public(). wabot
// only ever posts inbound WhatsApp turns, so its key opens nothing else.
const CALLER_ROUTES: Readonly<Record<ApiCaller, RegExp | null>> = {
  dashboard: null,
  wabot: /^\/wabot\/inbound\/?$/,
};

export type ApiKeyRejection = 'missing' | 'invalid' | 'forbidden_route';
export type ApiKeyVerdict =
  | { ok: true; caller: ApiCaller }
  | { ok: false; reason: ApiKeyRejection };

export type ApiKeys = ReadonlyMap<ApiCaller, Buffer>;

// The configured keys, read once at boot.
export function readApiKeys(env: NodeJS.ProcessEnv = process.env): ApiKeys {
  const keys = new Map<ApiCaller, Buffer>();
  for (const caller of API_CALLERS) {
    const value = env[API_KEY_ENV[caller]];
    if (typeof value === 'string' && value.length > 0) {
      keys.set(caller, Buffer.from(value));
    }
  }
  return keys;
}

// Startup check: a pp-sketch with no key configured would reject every
// request from the dashboard and from wabot, so fail loudly at boot rather
// than silently on the first call.
export function assertApiKeyEnv(env: NodeJS.ProcessEnv = process.env): void {
  const missing = API_CALLERS.filter((c) => !readApiKeys(env).has(c));
  if (missing.length === API_CALLERS.length) {
    throw new Error(
      `No API keys configured: set ${API_CALLERS.map((c) => API_KEY_ENV[c]).join(' and ')}`,
    );
  }
}

function matches(provided: Buffer, expected: Buffer): boolean {
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

// Which caller (if any) the presented key belongs to, and whether that caller
// may reach `path`. Constant-time against every configured key.
export function authenticateApiKey(
  provided: unknown,
  path: string,
  keys: ApiKeys,
): ApiKeyVerdict {
  if (typeof provided !== 'string' || provided.length === 0) {
    return { ok: false, reason: 'missing' };
  }
  const presented = Buffer.from(provided);
  let caller: ApiCaller | null = null;
  // No early exit: compare against every key so the response time does not
  // reveal which caller's key (if any) matched.
  for (const [candidate, expected] of keys) {
    if (matches(presented, expected)) caller = candidate;
  }
  if (!caller) return { ok: false, reason: 'invalid' };
  const scope = CALLER_ROUTES[caller];
  if (scope && !scope.test(path))
    return { ok: false, reason: 'forbidden_route' };
  return { ok: true, caller };
}
