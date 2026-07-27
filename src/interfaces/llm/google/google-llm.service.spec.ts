jest.mock('../llm-client', () => ({
  callChatCompletions: jest.fn().mockResolvedValue({ text: 'ok' }),
  runCompletionBatch: jest.fn().mockResolvedValue([]),
}));

import { callChatCompletions, runCompletionBatch } from '../llm-client';
import { GoogleLlmService } from './google-llm.service';

describe('GoogleLlmService', () => {
  const service = new GoogleLlmService();
  const request = {
    model: 'm',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('carries the google provider config', () => {
    expect(service.config.provider).toBe('google');
    expect(service.config.envKey).toBe('GEMINI_API_KEY');
    expect(service.config.baseUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai',
    );
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
