# llm-generate.dto.ts — `POST /media-meta-data/llm-generate` contract

Request validation, generated-content parsing and the derived stids for the
LLM seeding path (dashboard → MediaMetaDataService → src/interfaces/llm).
One request = one generation: LLM call → schema validation → passage-judge
gate → zero-context solvability filter → entity tree insert of ONE passage
with ONE question (media-meta-data.service.prompt.md).

## validateLlmGenerateRequest(body) → LlmGenerateRequest

Runtime-validates the untrusted body; every failure is a
BadRequestException.

- `provider` — must be in **`GENERATION_LLM_PROVIDERS`** = openai,
  anthropic, mistral, sarvam. **Google is deliberately excluded**: it is
  reserved for the realtime onboarding classifier (src/onboarding), the one
  LLM call a human waits on, so it keeps its own key, quota (per Google
  Cloud project) and failure domain — an OpenAI incident mid-run cannot stall
  a parent mid-consent, and a generation run cannot exhaust the classifier's
  quota. Error: `provider must be one of: <list> ('google' is reserved for
  the realtime onboarding classifier)`. There is no server-side default;
  the dashboard (pp-dashboard `SEED_PROVIDER_MAP`) is the only caller and no
  longer offers Gemini. `VALID_LLM_PROVIDERS` (llm.dto.ts) is unchanged and
  `GoogleLlmService` stays registered — do not re-add Google here.
- `model` — non-empty string, provider-native id.
- `messages` — non-empty array of `{ role: system|user|assistant, content:
  string }`; unknown fields are dropped (no passthrough of untrusted keys).

## Generated content

`parseGeneratedContent` / the schema types: exactly one passage + one
question (2–4 options, one correct, each with an explanation;
`send_as_flow` marks comprehension questions sent as a WhatsApp Flow).
Flow option descriptions are capped at 300 chars (Meta limit, re-enforced at
send time). Passage level from word count: <10 → 8, <40 → 9, <70 → 10,
<110 → 11, else 12 (`passageLevelFromWordCount`); level 13 (250+) never
enters lessons. Passages containing digits are rejected (2026-09, #85).

## Derived stids

`comprehensionFlowStid(passageId)` = `${passageId}-sentence-comprehension`
(the flow row); `comprehensionCompleteStid(answerId)` =
`${answerId}-comprehension-complete` (the explanation media);
`COMPREHENSION_RUNTIME_STID_RE` matches the machine's runtime
`${passageId}-sentence-comprehension-correct-first|retry` stids that
`findMediaByStateTransitionId` maps back to the flow row.
