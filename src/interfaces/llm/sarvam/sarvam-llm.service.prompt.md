# SarvamLlmService

Thin `@Injectable` carrying the sarvam `LlmProviderConfig`
(`https://api.sarvam.ai/v1`, key `SARVAM_API_KEY` — same account/key as the
STT engine, auth header `api-subscription-key` with no prefix, extraBody
`{reasoning_effort: null}` to disable reasoning) and delegating `complete` /
`completeBatch` to the shared transport in `../llm-client.ts`.

Named SarvamLlmService to avoid colliding with the STT SarvamService;
media rows generated via this provider use source `sarvam-llm`.

Also runs the zero-context-solvability filter (sarvam-105b) invoked by
`MediaMetaDataService`. Full behavior contract: `../llm.prompt.md`.
