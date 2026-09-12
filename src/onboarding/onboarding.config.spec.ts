import {
  DISALLOWED_MODEL_PATTERNS,
  assertOnboardingEnv,
  onboardingCutoff,
  onboardingLlm,
} from './onboarding.config';

const ENV = [
  'ONBOARDING_CUTOFF',
  'ONBOARDING_LLM_PROVIDER',
  'ONBOARDING_LLM_MODEL',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'MISTRAL_API_KEY',
  'SARVAM_API_KEY',
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.ONBOARDING_CUTOFF = '2026-09-15T00:00:00Z';
  process.env.ONBOARDING_LLM_PROVIDER = 'google';
  process.env.ONBOARDING_LLM_MODEL = 'gemini-2.5-flash-lite';
  process.env.GEMINI_API_KEY = 'test-key';
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('onboardingLlm — production configuration', () => {
  it('accepts google + gemini-2.5-flash-lite with GEMINI_API_KEY set', () => {
    expect(onboardingLlm()).toEqual({
      provider: 'google',
      model: 'gemini-2.5-flash-lite',
    });
    expect(() => assertOnboardingEnv()).not.toThrow();
  });

  it('accepts the other non-sarvam providers when their key is present', () => {
    process.env.ONBOARDING_LLM_PROVIDER = 'openai';
    process.env.ONBOARDING_LLM_MODEL = 'gpt-4.1-nano';
    process.env.OPENAI_API_KEY = 'k';
    expect(onboardingLlm().provider).toBe('openai');
  });
});

describe('onboardingLlm — reasoning-model tripwire', () => {
  it.each([
    ['o1', /^o\d/],
    ['o4-mini', /^o\d/],
    ['gpt-5', /^gpt-5/],
    ['gpt-5-mini', /^gpt-5/],
    ['gemini-2.5-pro', /^gemini-.*-pro/],
    ['gemini-3.1-pro-preview', /^gemini-.*-pro/],
    ['gemini-3-flash-preview', /^gemini-3/],
    ['gemini-3.5-flash-lite', /^gemini-3/],
    ['claude-x-thinking', /-thinking\b/],
    ['some-reasoning-model', /-reasoning\b/],
    ['deepseek-reasoner', /-reasoner\b/],
    ['grok-4', /^grok-4/],
    ['grok-4-fast', /^grok-4/],
  ])('rejects %s (matches %s)', (model, pattern) => {
    expect(DISALLOWED_MODEL_PATTERNS.some((re) => re.test(model))).toBe(true);
    process.env.ONBOARDING_LLM_MODEL = model;
    expect(() => onboardingLlm()).toThrow(
      new RegExp(`ONBOARDING_LLM_MODEL=${model} is not supported.*reasoning`),
    );
    expect(() => onboardingLlm()).toThrow(String(pattern).slice(1, -1));
  });

  it.each([
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gpt-4.1-nano',
    'gpt-4o-mini',
    'claude-haiku-4-5-20251001',
    'ministral-3b-latest',
  ])('passes %s', (model) => {
    process.env.ONBOARDING_LLM_MODEL = model;
    expect(DISALLOWED_MODEL_PATTERNS.some((re) => re.test(model))).toBe(false);
    expect(() => onboardingLlm()).not.toThrow();
  });
});

describe('onboardingLlm — env errors', () => {
  it('throws when the provider is unset or unknown', () => {
    delete process.env.ONBOARDING_LLM_PROVIDER;
    expect(() => onboardingLlm()).toThrow(
      /ONBOARDING_LLM_PROVIDER must be one of .* \(got undefined\)/,
    );
    process.env.ONBOARDING_LLM_PROVIDER = 'krutrim';
    expect(() => onboardingLlm()).toThrow(/got "krutrim"/);
  });

  it('refuses sarvam', () => {
    process.env.ONBOARDING_LLM_PROVIDER = 'sarvam';
    process.env.SARVAM_API_KEY = 'k';
    expect(() => onboardingLlm()).toThrow(
      'ONBOARDING_LLM_PROVIDER=sarvam is not supported',
    );
  });

  it('throws when the model is unset', () => {
    delete process.env.ONBOARDING_LLM_MODEL;
    expect(() => onboardingLlm()).toThrow('ONBOARDING_LLM_MODEL must be set');
  });

  it("throws when the provider's API key is missing (boot, not first call)", () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => onboardingLlm()).toThrow(
      'GEMINI_API_KEY must be set for ONBOARDING_LLM_PROVIDER=google',
    );
    process.env.ONBOARDING_LLM_PROVIDER = 'anthropic';
    process.env.ONBOARDING_LLM_MODEL = 'claude-haiku-4-5-20251001';
    expect(() => onboardingLlm()).toThrow(
      'ANTHROPIC_API_KEY must be set for ONBOARDING_LLM_PROVIDER=anthropic',
    );
  });
});

describe('onboardingCutoff', () => {
  it('parses the ISO timestamp', () => {
    expect(onboardingCutoff().toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });

  it('throws when unset or unparseable', () => {
    delete process.env.ONBOARDING_CUTOFF;
    expect(() => onboardingCutoff()).toThrow(/ONBOARDING_CUTOFF must be set/);
    expect(() => assertOnboardingEnv()).toThrow(/ONBOARDING_CUTOFF/);
    process.env.ONBOARDING_CUTOFF = 'yesterday';
    expect(() => onboardingCutoff()).toThrow(/got "yesterday"/);
  });
});
