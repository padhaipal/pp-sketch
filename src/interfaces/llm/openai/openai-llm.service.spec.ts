jest.mock('../llm-client', () => ({
  callChatCompletions: jest.fn().mockResolvedValue({ text: 'ok' }),
  runCompletionBatch: jest.fn().mockResolvedValue([]),
}));

import { callChatCompletions, runCompletionBatch } from '../llm-client';
import { OpenaiLlmService } from './openai-llm.service';

describe('OpenaiLlmService', () => {
  const service = new OpenaiLlmService();
  const request = {
    model: 'm',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('carries the openai provider config', () => {
    expect(service.config.provider).toBe('openai');
    expect(service.config.envKey).toBe('OPENAI_API_KEY');
    expect(service.config.baseUrl).toBe('https://api.openai.com/v1');
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
