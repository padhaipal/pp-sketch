# MistralLlmService

Thin `@Injectable` carrying the mistral `LlmProviderConfig`
(`https://api.mistral.ai/v1`, key `MISTRAL_API_KEY`, standard `Authorization: Bearer`)
and delegating `complete` / `completeBatch` to the shared transport in
`../llm-client.ts`. Full behavior contract (timeouts, retries, error
normalization, observability): `../llm.prompt.md`.
