# src/interfaces/llm — LLM provider interfaces

One folder per third-party LLM entity (mirrors `src/interfaces/stt`):
`openai/`, `anthropic/`, `google/`, `mistral/`, `sarvam/`. Each folder holds a
single `@Injectable` service (`<Provider>LlmService`) exposing:

- `complete(request, options?) → Promise<LlmResult>` — one chat-completions
  call.
- `completeBatch(requests, options?) → Promise<LlmBatchItem[]>` — bounded
  concurrency pool (default 8) over `complete`; never rejects; slots are
  index-aligned `{result}` or `{result: null, error: {message, retriable}}`.

## Divergence from the STT pattern (deliberate)

STT services write their own `media_metadata` transcript row. LLM services are
**pure API clients** and never touch the database: one completion fans out
into many linked entities (passage → questions → options → explanations →
flows) only after schema validation and the zero-context-solvability filter,
all of which live in `MediaMetaDataService`.

## Shared transport — `llm-client.ts`

All five providers speak OpenAI-compatible `POST {baseUrl}/chat/completions`
(non-streaming), so the transport lives once in `llm-client.ts` and services
carry only an `LlmProviderConfig` (`baseUrl`, `envKey`, optional
`authHeader`/`authPrefix`/`extraBody`). Contract:

- API key read from `process.env[envKey]` at call time; missing → immediate
  non-retriable `LlmError`.
- Per-call timeout `LLM_TIME_CAP` seconds (default 45) via AbortController.
- 429/5xx/network/timeout → retriable; retried up to `maxAttempts` (default 3)
  with jittered exponential backoff (base 1 s, `Retry-After` honored). Other
  4xx and empty completions → non-retriable, thrown immediately.
- Every failure is normalized to `LlmError { retriable, status?,
  retryAfterSeconds? }`. The `retriable` flag is surfaced end-to-end so the
  dashboard can offer "try again" only when it can help.
- No provider async-batch APIs and no BullMQ queues (product decision
  2026-07-27): seeding requests are synchronous per-generation HTTP calls and
  Sarvam (the solvability model) has no batch API.

## Observability

- Span `llm.complete` per call: `pp.llm.provider`, `pp.llm.model`,
  `pp.llm.attempts`, `pp.llm.completion_tokens`; ERROR status + exception on
  terminal failure.
- Histogram `pp.llm.request_duration_ms` (`provider`, `outcome`), retries
  included; counts/error-rates derive from it.

## Env

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`,
`SARVAM_API_KEY` (shared with STT — same account), `LLM_TIME_CAP`.

## Registration

Providers are listed in `media-meta-data.module.ts` and constructor-injected
into `MediaMetaDataService` one-by-one, like the STT engines.

## media_metadata.source mapping

`LLM_PROVIDER_TO_MEDIA_SOURCE` in `llm.dto.ts`. Identity except
`sarvam → 'sarvam-llm'` ('sarvam' is taken by the STT engine; existing rows
are never migrated).
