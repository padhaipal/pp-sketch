# AnthropicLlmService

Thin `@Injectable` carrying the anthropic `LlmProviderConfig`
(`https://api.anthropic.com/v1`, key `ANTHROPIC_API_KEY`, standard `Authorization: Bearer`)
and delegating `complete` / `completeBatch` to the shared transport in
`../llm-client.ts`. Full behavior contract (timeouts, retries, error
normalization, observability): `../llm.prompt.md`.
