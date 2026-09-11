# onboarding.service.ts — parent onboarding turns

Entity service for `onboarding_states` (append-only; one row per turn,
newest row = current state; `user_message_id` UNIQUE). All writes to the
table live here; the users columns it fills go through
`UserService.update`. Layering: this module must NOT import
src/interfaces/wabot (eslint no-restricted-imports enforces it for
inbound.utils) — it returns stids and text, the processor turns them into
WhatsApp media.

Who is un-onboarded: `UserService.isOnboarded(user)` (user.service.prompt.md)
— post-cutoff students with no birth_year / recording permission yet. The
processor routes every message from such a user here (inbound.processor.prompt.md
step 4a).

## Env (validated at bootstrap by `assertOnboardingEnv()` in onboarding.config.ts)

- `ONBOARDING_CUTOFF` — ISO timestamp; users created before it are
  grandfathered. Set to the deploy timestamp of the onboarding release.
- `ONBOARDING_LLM_PROVIDER` — openai | anthropic | google | mistral. Sarvam
  is refused (its 2 s process-wide send pacing breaks the 5 s budget).
- `ONBOARDING_LLM_MODEL` — provider-native model id for the classifier.

## handleTurn({ user, transcripts?, user_message_id }) → { stateTransitionIds, texts }

1. Newest row for the user (inline SELECT, `(user_id, created_at)` index).
2. No row, OR the row's snapshot fails to restore (log ERROR — machine shape
   changed, corrupt row; never crash-loop the job): insert the initial
   askGuardian snapshot under this `user_message_id` and return
   `['onboarding-ask-guardian']`. No classification (a text first message
   has no transcripts).
3. Restored snapshot already `done`: only reachable if the done turn's cache
   eviction was lost — the user IS onboarded in the DB. Log ERROR, evict
   the user cache again, return `['onboarding-complete']`, insert nothing.
4. Otherwise: `interpretFor(snapshot)`; kind `none` skips classification
   (value `ANY`), else `classify(transcripts, interpret, state)`. Send
   `REPLY { value, istYear: istYear() }` (Asia/Kolkata calendar year).
5. One transaction: INSERT the new row; if the machine is now `done`, also
   `UserService.update({ id, new_birth_year, new_birth_month,
   new_recording_permissions_obtained_at: now, new_name? }, manager)` —
   `new_name` only when a name was extracted (never clobber a name with
   null). Inside the transaction update() only evicts the cache.
6. After commit, done only: `UserService.invalidateCache(user)` (closes the
   repopulate race), push `referralText(user.external_id)` to `texts`, call
   `literacyLessonService.processAnswer({ user, user_message_id })` to start
   lesson one and append its stids and any `sentenceText`. A failure here
   fails the job; the retry's rollback undoes the done row (below).
7. Return the machine's `context.stateTransitionIds` (+ lesson stids) and
   `texts`.

## rollback(user_message_id)

DELETE the row for that message (RETURNING user_id, snapshot); no row → no-op.
If the deleted snapshot was `done`: `UserService.update` birth_year,
birth_month, recording_permissions_obtained_at back to null (name is left),
and `literacyLessonService.cleanupPartialState(user_message_id)` removes
the lesson-one rows. Called by the processor on a BullMQ retry
(`job.attemptsMade > 0`, before handleTurn) and on `delivered: false`.

## classify(transcripts, interpret, state) → string

Single `complete()` through src/interfaces/llm on the env provider/model:
system prompt below, user message = every transcript as
`Transcript n: <text>` lines, `temperatureRatio: 0`, `max_tokens: 40`,
options `{ timeoutMs: 5000, maxAttempts: 1 }` — never the batch pool. An
LlmError propagates (the job retries the whole turn).

System prompts (verbatim):

- enum: `Reply with exactly one of: {options}. Transcripts of one reply from several speech engines follow. If none clearly matches, reply UNINTELLIGIBLE.`
- integer: `Reply with the integer only, or UNINTELLIGIBLE.`
- month: `Reply with the month number 1–12, or NONE.`
- name: `Extract the person's name from these transcripts, in the script it appears in. Reply with the name only, or NONE.`

`normalizeClassification(text, interpret)` collapses the output onto the
allowed set — the machine never sees raw model text:

- enum: trim, upper-case, strip non-letters at both ends; must equal one
  option, else UNINTELLIGIBLE.
- integer: `^\d{1,3}\.?$` → the integer (leading zeros dropped), else
  UNINTELLIGIBLE. Range is the MACHINE's job (askAge retry).
- month: `^\d{1,2}\.?$` in 1–12 → the number, else NONE.
- name: strip surrounding quotes/trailing period; empty, >60 chars,
  multi-line, `none` or `unintelligible` → NONE.

Logs `onboarding.classify.result state=<state> kind=<kind> outcome=<value>
provider=<p> duration_ms=<n>` on every call for the UNINTELLIGIBLE rate.
Names are PII: for kind `name` the outcome is `name` or `NONE`, never the
name itself.
