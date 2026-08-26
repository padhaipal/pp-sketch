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
export class MistralLlmService {
  readonly config: LlmProviderConfig = {
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    envKey: 'MISTRAL_API_KEY',
    // Mistral's schema allows up to 1.5 (docs recommend ≤0.7).
    temperatureMax: 1.5,
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
