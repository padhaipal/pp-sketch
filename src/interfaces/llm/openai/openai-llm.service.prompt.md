# OpenaiLlmService

Thin `@Injectable` carrying the openai `LlmProviderConfig`
(`https://api.openai.com/v1`, key `OPENAI_API_KEY`, standard `Authorization: Bearer`)
and delegating `complete` / `completeBatch` to the shared transport in
`../llm-client.ts`. Full behavior contract (timeouts, retries, error
normalization, observability): `../llm.prompt.md`.
