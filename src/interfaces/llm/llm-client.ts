/**
 * Shared OpenAI-compatible chat-completions caller used by every provider
 * service in src/interfaces/llm/<provider>. All five v1 providers speak the
 * `POST {baseUrl}/chat/completions` shape (Sarvam with a custom auth header),
 * so the transport lives here once and each provider service is a thin
 * @Injectable carrying only its LlmProviderConfig.
 *
 * Behavior contract (mirrors the STT services'):
 *  - per-call timeout = LLM_TIME_CAP seconds (default 45) via AbortController
 *  - 429/5xx/network errors are retried with jittered exponential backoff
 *    (Retry-After honored); other 4xx throw immediately as non-retriable
 *  - every failure is normalized to LlmError
 *  - sarvam sends (only) are paced ≥2s apart process-wide, retries included
 *    (SARVAM_LLM_MIN_SEND_INTERVAL_MS overrides; 0 disables) — sarvam-105b's
 *    rate limit is 40 req/min on the Starter tier. NOTE: the pacing wait is
 *    included in the pp.llm.request_duration_ms histogram (it measures the
 *    caller-observed call, queueing and retries included).
 *
 * Batch calls are a bounded-concurrency pool over single calls — deliberately
 * NOT the providers' async batch APIs (no queues per product decision
 * 2026-07-27, and Sarvam — the zero-context-solvability model — has none).
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { tracer } from '../../otel/otel';
import { llmRequestDuration } from '../../otel/metrics';
import {
  LlmBatchItem,
  LlmBatchOptions,
  LlmCallOptions,
  LlmError,
  LlmProviderConfig,
  LlmRequest,
  LlmResult,
  DEFAULT_TEMPERATURE_RATIO,
} from './llm.dto';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_BATCH_CONCURRENCY = 8;

// Sarvam allows only 40 req/min on sarvam-105b (Starter tier; 60 Pro /
// 120 Business — docs.sarvam.ai rate limits, per-account across all keys),
// so every sarvam send in this process — generation, gate runs, retries —
// is serialized through a shared slot queue spaced 2s apart (~30 rpm).
// Override via SARVAM_LLM_MIN_SEND_INTERVAL_MS (0 disables). Other
// providers are unpaced.
const DEFAULT_SARVAM_MIN_SEND_INTERVAL_MS = 2000;
const paceTails = new Map<string, Promise<void>>();

function minSendIntervalMs(provider: string): number {
  if (provider !== 'sarvam') return 0;
  const parsed = parseInt(
    process.env.SARVAM_LLM_MIN_SEND_INTERVAL_MS ?? '',
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SARVAM_MIN_SEND_INTERVAL_MS;
}

// Resolves when this caller may send, and books the next caller's slot one
// interval later — concurrent callers thereby serialize at the interval.
function awaitSendSlot(provider: string): Promise<void> {
  const interval = minSendIntervalMs(provider);
  if (interval === 0) return Promise.resolve();
  const prev = paceTails.get(provider) ?? Promise.resolve();
  paceTails.set(
    provider,
    prev.then(() => sleep(interval)),
  );
  return prev;
}

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(
  attempt: number,
  baseMs: number,
  retryAfterSeconds?: number,
): number {
  if (
    retryAfterSeconds !== undefined &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    return retryAfterSeconds * 1000;
  }
  const exp = baseMs * 2 ** attempt;
  return exp + Math.random() * 0.25 * exp;
}

async function singleCall(
  config: LlmProviderConfig,
  request: LlmRequest,
): Promise<LlmResult> {
  const apiKey = process.env[config.envKey];
  if (!apiKey) {
    throw new LlmError(`Missing ${config.envKey}`, false);
  }

  // Rate pacing before the timeout clock starts — the wait for a send slot
  // must not eat into LLM_TIME_CAP.
  await awaitSendSlot(config.provider);

  const timeCapMs = parseInt(process.env.LLM_TIME_CAP ?? '45', 10) * 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeCapMs);
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [config.authHeader ?? 'Authorization']:
          `${config.authPrefix ?? 'Bearer '}${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.max_tokens !== undefined
          ? { max_tokens: request.max_tokens }
          : {}),
        // Always specified — scaled from the caller's ratio to this
        // provider's range. extraBody still wins (provider quirks by data).
        temperature:
          (request.temperatureRatio ?? DEFAULT_TEMPERATURE_RATIO) *
          config.temperatureMax,
        ...config.extraBody,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    throw new LlmError(
      aborted
        ? `${config.provider} timed out after ${timeCapMs} ms`
        : `${config.provider} network error: ${(err as Error).message}`,
      true,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    const retriable = response.status === 429 || response.status >= 500;
    const retryAfterHeader = response.headers?.get?.('retry-after');
    const retryAfterSeconds =
      retryAfterHeader != null && Number.isFinite(Number(retryAfterHeader))
        ? Number(retryAfterHeader)
        : undefined;
    throw new LlmError(
      `${config.provider} ${response.status}: ${body}`,
      retriable,
      response.status,
      retryAfterSeconds,
    );
  }

  const json = (await response.json()) as ChatCompletionsResponse;
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new LlmError(
      `${config.provider} returned an empty completion`,
      false,
    );
  }

  return {
    text,
    model: request.model,
    prompt_tokens: json.usage?.prompt_tokens ?? null,
    completion_tokens: json.usage?.completion_tokens ?? null,
    duration_ms: Date.now() - started,
  };
}

export async function callChatCompletions(
  config: LlmProviderConfig,
  request: LlmRequest,
  options?: LlmCallOptions,
): Promise<LlmResult> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseMs = options?.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;

  return tracer.startActiveSpan('llm.complete', async (span) => {
    span.setAttribute('pp.llm.provider', config.provider);
    span.setAttribute('pp.llm.model', request.model);
    const started = Date.now();
    try {
      let lastError: LlmError | undefined;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const result = await singleCall(config, request);
          span.setAttribute('pp.llm.attempts', attempt + 1);
          span.setAttribute(
            'pp.llm.completion_tokens',
            result.completion_tokens ?? 0,
          );
          llmRequestDuration.record(Date.now() - started, {
            provider: config.provider,
            outcome: 'success',
          });
          return result;
        } catch (err) {
          lastError =
            err instanceof LlmError
              ? err
              : new LlmError((err as Error).message, false);
          if (!lastError.retriable || attempt === maxAttempts - 1) break;
          await sleep(backoffMs(attempt, baseMs, lastError.retryAfterSeconds));
        }
      }
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: lastError!.message,
      });
      span.recordException(lastError!);
      llmRequestDuration.record(Date.now() - started, {
        provider: config.provider,
        outcome: 'error',
      });
      throw lastError!;
    } finally {
      span.end();
    }
  });
}

/**
 * Runs every request through callChatCompletions with a bounded-concurrency
 * pool. Never rejects: each slot is either a result or a normalized error,
 * index-aligned with the input, so callers can report per-item failures.
 */
export async function runCompletionBatch(
  config: LlmProviderConfig,
  requests: LlmRequest[],
  options?: LlmBatchOptions,
): Promise<LlmBatchItem[]> {
  const concurrency = Math.max(
    1,
    Math.min(
      options?.concurrency ?? DEFAULT_BATCH_CONCURRENCY,
      requests.length,
    ),
  );
  const items: LlmBatchItem[] = new Array<LlmBatchItem>(requests.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < requests.length) {
      const index = next++;
      try {
        items[index] = {
          result: await callChatCompletions(config, requests[index], options),
        };
      } catch (err) {
        const llmError =
          err instanceof LlmError
            ? err
            : new LlmError((err as Error).message, false);
        items[index] = {
          result: null,
          error: { message: llmError.message, retriable: llmError.retriable },
        };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return items;
}
