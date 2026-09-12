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
    // Google is reserved for the realtime onboarding classifier (5 s budget,
    // one attempt), so thinking is disabled at the provider: hidden reasoning
    // tokens would eat the budget before any output. 'none' is accepted by
    // 2.5 models only — Gemini 3.x cannot turn thinking off (floor
    // 'minimal'); see onboarding.config.ts for the migration notes.
    extraBody: { reasoning_effort: 'none' },
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
