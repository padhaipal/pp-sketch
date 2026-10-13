# share-message.service.ts — the "share with your WhatsApp group" message

`GET geo-entities/:id/share-message` (dashboard-scores.controller.ts; on the
pp-dashboard proxy's public allowlist). One fresh LLM generation per call —
the teacher dashboard asks on every load of the viewer's OWN unit — nothing
cached, nothing stored (decision 2026-10).

## Who may ask (`subjectFor`)

- `:id` a geo entity → the viewer (`@Viewer()`, pp-dashboard's `?viewer=`)
  must be a user whose `users.geo_entity_id` is that entity (a BEO on their
  block, a BSA on their district): audience `teachers`.
- `:id` not a geo entity → a teacher's class (their user id): the viewer
  must be that teacher (`education_official` on a school): audience
  `parents`; their referral link (`referralUrl(external_id)`) is the
  `{{SHARE_LINK}}`. Never the dashboard link.
- Anonymous → 403; another user → 403; neither → 404; staff may ask for any
  unit (support).
- Rate limit: `CacheService.incr('share-message:<viewer>', 60)` >
  `SHARE_MESSAGE_RATE_LIMIT` (10) → 429. Redis down → allowed. Staff not
  limited.

## What the model sees (`facts`)

Reads through `DashboardScoresService.scores(..., STAFF)` — full names,
because only placeholders leave the server — for usage/7d, usage/yesterday,
nipun_g1/g2/g3, mpl_b and (areas) the `nipun` verdict, in parallel; a
failing read drops its section (`warn`), never the message. Plus two reads
of its own: `share-message:teachers` (teachers under the area with the most
students and how many they enrolled this week — a recursive walk down
`geo_entity.parent_id`, soft-deletes excluded) and `share-message:class`
(class size, enrolled this week).

`Placeholders`: every PERSON (teacher, student) becomes `{{NAME_n}}` (first
name as stored, else the API's "Student N" label); places keep their names;
phones never appear. `variety_seed` is a random number per call so the
model picks a different angle each time. The whole facts object is the user
message as JSON; `SHARE_MESSAGE_SYSTEM_PROMPT` sets the rules: Hindi only,
3–6 lines, one or two angles, priority to whatever is remarkable in the
numbers (the model decides — no thresholds are hard-coded), placeholders
copied verbatim, no invented facts, no phone numbers, `{{SHARE_LINK}}` as
the last line for parents and no link for teachers.

## Model

`shareMessageLlm()`: `SHARE_MESSAGE_LLM_PROVIDER` / `_MODEL`, default
anthropic / claude-haiku-5-5 (fast, strong Hindi, no shared rate cap);
google refused (reserved for the onboarding classifier). One attempt,
12 s timeout, max_tokens 700, temperatureRatio 0.9 — a page load waits on
this.

## Finishing (`finishMessage`)

Placeholders → names, `{{SHARE_LINK}}` → the link (appended on its own line
if the model forgot it), any other `{{…}}` dropped, phone-like digit runs
removed (the link is protected), whitespace tidied, capped at 1200 chars.

## 2026-10: LLM failures are a 503

An `LlmError` from the provider becomes `ServiceUnavailableException` with
the provider's message ("credit balance is too low", "`temperature` is
deprecated…") and an error log line carrying it — the first rollout
surfaced only "Internal server error" and the message lived in the trace.
