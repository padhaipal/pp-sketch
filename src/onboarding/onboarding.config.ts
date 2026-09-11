import {
  LlmProvider,
  PROVIDER_ENV_KEYS,
  VALID_LLM_PROVIDERS,
} from '../interfaces/llm/llm.dto';

// Required env for parent onboarding. Read lazily by the callers below and
// validated once at bootstrap (main.ts) so a misconfigured deploy fails at
// startup instead of on the first parent's reply.

// Users created before this instant are grandfathered: they never see the
// onboarding flow. Set it to the deploy timestamp of the onboarding release.
export function onboardingCutoff(): Date {
  const raw = process.env.ONBOARDING_CUTOFF;
  const parsed = raw ? new Date(raw) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new Error(
      `ONBOARDING_CUTOFF must be set to an ISO timestamp (got ${JSON.stringify(raw)})`,
    );
  }
  return parsed;
}

// Tripwire for obvious mistakes only — the real guarantee is the provider-level
// reasoning_effort: 'none' (GoogleLlmService.config.extraBody) plus the staging
// p95 check. Reasoning models emit hidden tokens before any output; with a 5 s
// cap and maxAttempts: 1 that is a guaranteed UNINTELLIGIBLE.
export const DISALLOWED_MODEL_PATTERNS: readonly RegExp[] = [
  /^o\d/,
  /^gpt-5/,
  /^gemini-.*-pro/,
  /^gemini-3/,
  /-thinking\b/,
  /-reasoning\b/,
  /-reasoner\b/,
  /^grok-4/,
];

// REVIEW: the pinned classifier model is ONBOARDING_LLM_MODEL=gemini-2.5-flash-lite
// (see .env.example) — 2.5 is three generations behind and will deprecate
// (no shutdown date announced as of 2026-09). Migrating to gemini-3.5-flash-lite
// is three coupled edits: the model id, removing /^gemini-3/ from the denylist
// above, and GoogleLlmService.config.extraBody → reasoning_effort: 'minimal'
// (3.5 Flash-Lite's floor is minimal, not low, and 'none' is 2.5-only).
// Without all three the app fails at boot — correct behaviour, but this is
// the pointer. Choose the successor on measured staging p95
// (pp.llm.request_duration_ms, provider=google), not on paper. Check
// https://ai.google.dev/gemini-api/docs/deprecations before merging that.

// Sarvam is excluded: its 2 s process-wide send pacing (llm-client.ts) is
// incompatible with a 5 s per-turn classifier budget.
export function onboardingLlm(): { provider: LlmProvider; model: string } {
  const provider = process.env.ONBOARDING_LLM_PROVIDER;
  if (
    !provider ||
    !(VALID_LLM_PROVIDERS as readonly string[]).includes(provider)
  ) {
    throw new Error(
      `ONBOARDING_LLM_PROVIDER must be one of ${VALID_LLM_PROVIDERS.join(', ')} (got ${JSON.stringify(provider)})`,
    );
  }
  if (provider === 'sarvam') {
    throw new Error('ONBOARDING_LLM_PROVIDER=sarvam is not supported');
  }
  const model = process.env.ONBOARDING_LLM_MODEL;
  if (!model) {
    throw new Error('ONBOARDING_LLM_MODEL must be set');
  }
  const disallowed = DISALLOWED_MODEL_PATTERNS.find((re) => re.test(model));
  if (disallowed) {
    throw new Error(
      `ONBOARDING_LLM_MODEL=${model} is not supported: it matches ${String(disallowed)}, a reasoning model — the classifier needs a non-thinking model`,
    );
  }
  // llm-client only discovers a missing key at call time (non-retriable), so
  // a deploy without it would fail every parent turn instead of startup.
  const envKey = PROVIDER_ENV_KEYS[provider as LlmProvider];
  if (!process.env[envKey]) {
    throw new Error(
      `${envKey} must be set for ONBOARDING_LLM_PROVIDER=${provider}`,
    );
  }
  return { provider: provider as LlmProvider, model };
}

export function assertOnboardingEnv(): void {
  onboardingCutoff();
  onboardingLlm();
}
