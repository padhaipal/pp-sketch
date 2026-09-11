import { PROVIDER_ENV_KEYS, VALID_LLM_PROVIDERS } from './llm.dto';
import { OpenaiLlmService } from './openai/openai-llm.service';
import { AnthropicLlmService } from './anthropic/anthropic-llm.service';
import { GoogleLlmService } from './google/google-llm.service';
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
  it('disables thinking at the provider (2.5-only reasoning_effort: none)', () => {
    expect(new GoogleLlmService().config.extraBody).toEqual({
      reasoning_effort: 'none',
    });
  });
});
