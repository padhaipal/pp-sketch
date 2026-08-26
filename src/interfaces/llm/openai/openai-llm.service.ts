import { Injectable } from '@nestjs/common';
import { callChatCompletions, runCompletionBatch } from '../llm-client';
import {
  LlmBatchItem,
  LlmBatchOptions,
  LlmCallOptions,
  LlmProviderConfig,
  LlmRequest,
  LlmResult,
} from '../llm.dto';

@Injectable()
export class OpenaiLlmService {
  readonly config: LlmProviderConfig = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    // OpenAI chat completions accept 0–2.
    temperatureMax: 2,
  };

  complete(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResult> {
    return callChatCompletions(this.config, request, options);
  }

  completeBatch(
    requests: LlmRequest[],
    options?: LlmBatchOptions,
  ): Promise<LlmBatchItem[]> {
    return runCompletionBatch(this.config, requests, options);
  }
}
