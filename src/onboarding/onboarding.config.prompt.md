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
  `gemini-3.5-flash-lite`, pinned (never a `-latest` alias: Google hot-swaps
  those on every release, preview included). Refused when it matches
  `DISALLOWED_MODEL_PATTERNS` (`^o\d`, `^gpt-5`, `^gemini-.*-pro`,
  `-thinking`, `-reasoning`, `-reasoner`, `^grok-4`) — a tripwire for
  obvious reasoning models only; the real guarantee is the provider-side
  thinking floor (`googleReasoningEffort`: `'minimal'` on 3.x, `'none'` on
  2.5) plus the staging p95 check (`pp.llm.request_duration_ms`,
  provider=google).
- The provider's API key env (`PROVIDER_ENV_KEYS[provider]`, e.g.
  `GEMINI_API_KEY`) must be set — llm-client only notices a missing key at
  call time.

Why 3.5, not 2.5: `gemini-2.5-flash-lite` returns 404 "no longer available
to new users" for Google projects that had not used it (staging,
2026-09-15). 3.x cannot turn thinking off, so its latency is watched via
`onboarding.classify.result duration_ms` against the 5 s budget.

## assertOnboardingEnv()

Runs both. Also the place to add any future onboarding env.

Placeholders for every variable: `.env.example` (repo root; onboarding
vars only, not a full inventory).
