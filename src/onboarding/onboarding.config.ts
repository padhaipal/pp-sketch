import { LlmProvider, VALID_LLM_PROVIDERS } from '../interfaces/llm/llm.dto';

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
  return { provider: provider as LlmProvider, model };
}

export function assertOnboardingEnv(): void {
  onboardingCutoff();
  onboardingLlm();
}
