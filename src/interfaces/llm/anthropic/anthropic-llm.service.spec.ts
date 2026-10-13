jest.mock('../llm-client', () => ({
  callChatCompletions: jest.fn().mockResolvedValue({ text: 'ok' }),
  runCompletionBatch: jest.fn().mockResolvedValue([]),
}));

import { callChatCompletions, runCompletionBatch } from '../llm-client';
import {
  AnthropicLlmService,
  anthropicRejectsTemperature,
} from './anthropic-llm.service';

describe('AnthropicLlmService', () => {
  const service = new AnthropicLlmService();
  const request = {
    model: 'm',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('carries the anthropic provider config', () => {
    expect(service.config.provider).toBe('anthropic');
    expect(service.config.envKey).toBe('ANTHROPIC_API_KEY');
    expect(service.config.baseUrl).toBe('https://api.anthropic.com/v1');
  });

  it('delegates complete() to the shared client', async () => {
    await service.complete(request);
    expect(callChatCompletions).toHaveBeenCalledWith(
      service.config,
      request,
      undefined,
    );
  });

  it('delegates completeBatch() to the shared client', async () => {
    await service.completeBatch([request], { concurrency: 2 });
    expect(runCompletionBatch).toHaveBeenCalledWith(service.config, [request], {
      concurrency: 2,
    });
  });
});

describe('anthropicRejectsTemperature', () => {
  it('Claude 5-family ids omit temperature; 4.x ids keep it', () => {
    for (const m of [
      'claude-haiku-5-5',
      'claude-fable-5',
      'claude-sonnet-5',
      'claude-opus-5-5',
      'claude-fable-5.1',
    ]) {
      expect(anthropicRejectsTemperature(m)).toBe(true);
    }
    for (const m of [
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
      'claude-3-5-sonnet-20241022',
    ]) {
      expect(anthropicRejectsTemperature(m)).toBe(false);
    }
    expect(
      new AnthropicLlmService().config.omitTemperature?.('claude-haiku-5-5'),
    ).toBe(true);
  });
});
