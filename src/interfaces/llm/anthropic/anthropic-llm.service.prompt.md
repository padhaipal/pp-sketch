# AnthropicLlmService

Thin `@Injectable` carrying the anthropic `LlmProviderConfig`
(`https://api.anthropic.com/v1`, key `ANTHROPIC_API_KEY`, standard `Authorization: Bearer`)
and delegating `complete` / `completeBatch` to the shared transport in
`../llm-client.ts`. Full behavior contract (timeouts, retries, error
normalization, observability): `../llm.prompt.md`.

## 2026-10: Claude 5 models refuse `temperature`

`anthropicRejectsTemperature(model)` → `config.omitTemperature`: for
`claude-<name>-5…` ids the client sends no temperature at all (the API
answers 400 "`temperature` is deprecated for this model" otherwise).
