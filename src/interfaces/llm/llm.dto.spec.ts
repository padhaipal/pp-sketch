import { PROVIDER_ENV_KEYS, VALID_LLM_PROVIDERS } from './llm.dto';
import { OpenaiLlmService } from './openai/openai-llm.service';
import { AnthropicLlmService } from './anthropic/anthropic-llm.service';
import {
  GoogleLlmService,
  googleReasoningEffort,
} from './google/google-llm.service';
import { MistralLlmService } from './mistral/mistral-llm.service';
import { SarvamLlmService } from './sarvam/sarvam-llm.service';

describe('PROVIDER_ENV_KEYS', () => {
  const services = [
    new OpenaiLlmService(),
    new AnthropicLlmService(),
    new GoogleLlmService(),
    new MistralLlmService(),
    new SarvamLlmService(),
  ];

  it("matches every provider service's config.envKey (the map cannot drift)", () => {
    for (const service of services) {
      expect(PROVIDER_ENV_KEYS[service.config.provider]).toBe(
        service.config.envKey,
      );
    }
  });

  it('covers every VALID_LLM_PROVIDERS entry exactly once', () => {
    expect(Object.keys(PROVIDER_ENV_KEYS).sort()).toEqual(
      [...VALID_LLM_PROVIDERS].sort(),
    );
    expect(services.map((s) => s.config.provider).sort()).toEqual(
      [...VALID_LLM_PROVIDERS].sort(),
    );
  });
});

describe('GoogleLlmService — reserved for the onboarding classifier', () => {
  it.each([
    ['gemini-3.5-flash-lite', 'minimal'],
    ['gemini-3-flash-preview', 'minimal'],
    ['gemini-2.5-flash-lite', 'none'],
    ['gemini-2.5-flash', 'none'],
  ])(
    'holds thinking at the floor for %s (reasoning_effort: %s)',
    (model, effort) => {
      expect(googleReasoningEffort(model)).toBe(effort);
      const { extraBody } = new GoogleLlmService().config;
      expect(typeof extraBody === 'function' && extraBody(model)).toEqual({
        reasoning_effort: effort,
      });
    },
  );
});
