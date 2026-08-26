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

/**
 * Sarvam chat completions. Named SarvamLlmService to avoid colliding with the
 * STT SarvamService (src/interfaces/stt/sarvam); both read the same
 * SARVAM_API_KEY — one Sarvam account covers STT and LLM. media_metadata rows
 * generated through this provider use source 'sarvam-llm' ('sarvam' is the
 * STT transcript source).
 *
 * This provider also runs the zero-context-solvability filter (sarvam-105b,
 * see MediaMetaDataService).
 */
@Injectable()
export class SarvamLlmService {
  readonly config: LlmProviderConfig = {
    provider: 'sarvam',
    baseUrl: 'https://api.sarvam.ai/v1',
    envKey: 'SARVAM_API_KEY',
    authHeader: 'api-subscription-key',
    authPrefix: '',
    // Sarvam models default to reasoning; null disables it (matches the
    // pp-dashboard /llm playground's extraBody).
    extraBody: { reasoning_effort: null },
    // Sarvam accepts 0–2 (its own default is 0.2).
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
