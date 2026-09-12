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

`extraBody: { reasoning_effort: 'none' }` disables thinking at the provider
(the transport spreads `extraBody` last, so it wins over the request). Per
Google's OpenAI-compatibility page, `'none'` is accepted by 2.5 models only;
reasoning cannot be turned off for 2.5 Pro or 3.x. The pinned model is
`gemini-2.5-flash-lite` (ONBOARDING_LLM_MODEL); migration notes in
`src/onboarding/onboarding.config.ts`.
