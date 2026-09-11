# onboarding.config.ts — parent-onboarding env

Pure env readers, no I/O. Each throws with an actionable message; all are
run once by `assertOnboardingEnv()` at the top of `bootstrap()` in
src/main.ts so a misconfigured deploy fails at startup, never on a parent's
first reply. Callers also read them lazily (`UserService.isOnboarded`,
`OnboardingService.classify`), which is what the specs exercise.

## onboardingCutoff() → Date

`ONBOARDING_CUTOFF`, ISO timestamp. Users created before it are
grandfathered past onboarding. Set it to the deploy timestamp of the
onboarding release (#88).

## onboardingLlm() → { provider, model }

- `ONBOARDING_LLM_PROVIDER` — one of `VALID_LLM_PROVIDERS` (the full list;
  the reservation of Google for this classifier is enforced on the
  generation side, see media-meta-data/llm-generate.dto.prompt.md), but
  `sarvam` is refused: its 2 s process-wide send pacing cannot meet the 5 s
  per-turn budget. Production value: `google`.
- `ONBOARDING_LLM_MODEL` — provider-native id. Production value:
  `gemini-2.5-flash-lite`, pinned (never a `-latest` alias: Google hot-swaps
  those on every release, preview included, and a move onto a 3.x model
  would force thinking on). Refused when it matches
  `DISALLOWED_MODEL_PATTERNS` (`^o\d`, `^gpt-5`, `^gemini-.*-pro`,
  `^gemini-3`, `-thinking`, `-reasoning`, `-reasoner`, `^grok-4`) — a
  tripwire for obvious reasoning models only; the real guarantee is
  `GoogleLlmService.config.extraBody = { reasoning_effort: 'none' }` plus the
  staging p95 check (`pp.llm.request_duration_ms`, provider=google).
- The provider's API key env (`PROVIDER_ENV_KEYS[provider]`, e.g.
  `GEMINI_API_KEY`) must be set — llm-client only notices a missing key at
  call time.

Migrating the model (the `// REVIEW:` block in the source): to
`gemini-3.5-flash-lite` is three coupled edits — model id, drop `^gemini-3`
from the denylist, `extraBody` → `reasoning_effort: 'minimal'` (3.5
Flash-Lite's floor; `'none'` is 2.5-only). Choose on measured staging p95.

## assertOnboardingEnv()

Runs both. Also the place to add any future onboarding env.

Placeholders for every variable: `.env.example` (repo root; onboarding
vars only, not a full inventory).
