# interaction stream — the donor page's live student turns

`GET users/dashboard/interactions` (user.controller.ts, before `:id` routes)
→ `InteractionStreamService.get()` → `InteractionStreamResponse
{ computed_at, delay_s, rows: InteractionStreamRow[] }`, newest first.
Public through the pp-dashboard proxy allowlist; the page polls every 60 s.

- **Which turns**: interaction media (INTERACTION_MEDIA_SQL: WhatsApp voice
  notes and flow taps), not rolled back, at least
  `INTERACTION_STREAM_DELAY_S` (120 s) old, newest
  `INTERACTION_STREAM_LIMIT` (20). Students only: role student or null, not
  deleted, onboarded (UserService.isOnboarded rule), not a
  `LOAD_TEST_PHONE_PREFIX` number; only messages after
  recording_permissions_obtained_at; no onboarding turns.
- **Row** (interaction-stream.ts `toStreamRow`): `key` = sha256(media id)
  first 16 hex (no ids leave); `at`; `student` = maskPii(name) ("Student"
  when nameless); `kind` voice | tap; `answer` = voice: the transcript
  (sarvam → azure → bodhan → reverie, first non-empty) through
  censorTranscript then maskPii — first and last character only; tap: the
  chosen option's text; `correct_answer` = voice: GET users/:id/media's
  displayed answer (the word when a new word starts, after a tap, or with no
  previous lesson; else the previous lesson row's answer); tap: the
  question's correct option; `answer_correct` = tap: the chosen option's
  `correct`, voice: the lesson row's; `wpm` as users/:id/media (2+ word
  lesson, duration_ms). No audio, no school or place.
- **Cache**: one shared answer in pp-redis-cache
  (`CACHE_KEYS.interactionStream`, `CACHE_TTL.INTERACTION_STREAM` 45 s) —
  any number of visitors, about one query a minute; a concurrent miss
  shares the in-flight query. Log: `interaction-stream.computed rows= ms=`.
