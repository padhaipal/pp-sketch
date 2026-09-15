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

// Lowest thinking setting the model accepts. 2.5 models turn thinking off
// with 'none'; Gemini 3.x cannot turn it off and rejects 'none' — 'minimal'
// is the floor. (gemini-2.5-flash-lite is closed to new Google projects.)
export function googleReasoningEffort(model: string): 'none' | 'minimal' {
  return /^gemini-2\.5-/.test(model) ? 'none' : 'minimal';
}

@Injectable()
export class GoogleLlmService {
  readonly config: LlmProviderConfig = {
    provider: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'GEMINI_API_KEY',
    // Gemini's OpenAI-compatible endpoint accepts 0–2.
    temperatureMax: 2,
    // Google is reserved for the realtime onboarding classifier (5 s budget,
    // one attempt), so thinking is held at the model's floor: hidden
    // reasoning tokens would eat the budget before any output.
    extraBody: (model) => ({ reasoning_effort: googleReasoningEffort(model) }),
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
