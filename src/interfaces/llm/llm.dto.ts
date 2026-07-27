/**
 * Shared types for the LLM provider interfaces (src/interfaces/llm/<provider>).
 *
 * Mirrors the STT convention (src/interfaces/stt): one folder per third-party
 * entity. Unlike STT services, LLM services are pure API clients — they never
 * write media_metadata rows. Row creation/filtering/linking happens in
 * MediaMetaDataService so a single completion can fan out into many linked
 * entities after validation.
 */

export const VALID_LLM_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'mistral',
  'sarvam',
] as const;
export type LlmProvider = (typeof VALID_LLM_PROVIDERS)[number];

/**
 * media_metadata.source values for LLM-generated rows. Kept distinct from the
 * provider ids only where a name would clash with an existing source:
 * 'sarvam' is already taken by the STT engine, so the LLM writes 'sarvam-llm'.
 */
export const LLM_PROVIDER_TO_MEDIA_SOURCE: Record<LlmProvider, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  mistral: 'mistral',
  sarvam: 'sarvam-llm',
};

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  /** Provider-native model id, e.g. "claude-fable-5" or "sarvam-105b". */
  model: string;
  messages: LlmMessage[];
  max_tokens?: number;
  temperature?: number;
}

export interface LlmResult {
  text: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number;
}

/**
 * All provider failures are normalized to this. `retriable` drives both the
 * in-process retry loop and the `retriable` flag surfaced to the dashboard so
 * the user knows whether "try again" is appropriate.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
    readonly status?: number,
    /** Parsed Retry-After header (seconds), when the provider sent one. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Static per-provider wiring consumed by llm-client.ts. */
export interface LlmProviderConfig {
  provider: LlmProvider;
  /** OpenAI-compatible base URL; requests go to `${baseUrl}/chat/completions`. */
  baseUrl: string;
  /** Name of the env var holding the API key (read at call time). */
  envKey: string;
  /** Auth header name; defaults to "Authorization". */
  authHeader?: string;
  /** Auth value prefix; defaults to "Bearer ". */
  authPrefix?: string;
  /** Extra body fields merged into every request (provider quirks). */
  extraBody?: Record<string, unknown>;
}

/** One slot of a completeBatch() result, index-aligned with the input. */
export interface LlmBatchItem {
  result: LlmResult | null;
  error?: { message: string; retriable: boolean };
}

export interface LlmCallOptions {
  /** Retry attempts for retriable failures (429/5xx/network). Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms (exponential, jittered). Default 1000. Tests pass 1. */
  baseBackoffMs?: number;
}

export interface LlmBatchOptions extends LlmCallOptions {
  /** Concurrent in-flight requests. Default 8. */
  concurrency?: number;
}
