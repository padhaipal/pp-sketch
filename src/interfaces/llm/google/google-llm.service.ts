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
export class GoogleLlmService {
  readonly config: LlmProviderConfig = {
    provider: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'GEMINI_API_KEY',
    // Gemini's OpenAI-compatible endpoint accepts 0–2.
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
