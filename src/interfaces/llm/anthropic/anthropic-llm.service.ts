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

// Claude 5-family ids (claude-fable-5, claude-sonnet-5, claude-haiku-5-5, …)
// reject `temperature` with 400 "`temperature` is deprecated for this model"
// (seen 2026-10-13 on claude-haiku-5-5); the 4.x ids still take it.
export const anthropicRejectsTemperature = (model: string): boolean =>
  /^claude-[a-z]+-5(?:[-.]|$)/.test(model);

@Injectable()
export class AnthropicLlmService {
  // Anthropic's OpenAI-compat layer: chat completions only, which is all we
  // use. https://platform.claude.com/docs/en/api/openai-sdk
  readonly config: LlmProviderConfig = {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY',
    // Anthropic's OpenAI-compat layer accepts 0–1 (caps anything higher).
    temperatureMax: 1,
    omitTemperature: anthropicRejectsTemperature,
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
