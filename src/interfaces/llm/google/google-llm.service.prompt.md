# GoogleLlmService

Thin `@Injectable` carrying the google `LlmProviderConfig`
(`https://generativelanguage.googleapis.com/v1beta/openai`, key `GEMINI_API_KEY`, standard `Authorization: Bearer`)
and delegating `complete` / `completeBatch` to the shared transport in
`../llm-client.ts`. Full behavior contract (timeouts, retries, error
normalization, observability): `../llm.prompt.md`.

**Reserved for the realtime onboarding classifier** (src/onboarding) — the
one LLM call a human waits on. `POST /media-meta-data/llm-generate` rejects
`provider: 'google'` (llm-generate.dto.ts, `GENERATION_LLM_PROVIDERS`) so
batch generation never shares its key, quota or failure domain. The service
stays registered in `media-meta-data.module.ts` / `onboarding.module.ts` and
in both `llmServiceFor` switches; only request validation excludes it.

`extraBody` is a function of the request's model:
`{ reasoning_effort: googleReasoningEffort(model) }` — `'none'` for
`gemini-2.5-*` (thinking off), `'minimal'` otherwise (Gemini 3.x cannot turn
thinking off and rejects `'none'`). The transport spreads `extraBody` last, so
it wins over the request. The pinned model is `gemini-3.5-flash-lite`
(ONBOARDING_LLM_MODEL): `gemini-2.5-flash-lite` returns 404 "no longer
available to new users" for Google projects that had not used it.
