# GoogleLlmService

Thin `@Injectable` carrying the google `LlmProviderConfig`
(`https://generativelanguage.googleapis.com/v1beta/openai`, key `GEMINI_API_KEY`, standard `Authorization: Bearer`)
and delegating `complete` / `completeBatch` to the shared transport in
`../llm-client.ts`. Full behavior contract (timeouts, retries, error
normalization, observability): `../llm.prompt.md`.
