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
- `ONBOARDING_LLM_PROVIDER` — production `google`, which is reserved for
  this classifier (llm-generate rejects it, see
  src/interfaces/llm/llm.prompt.md). Sarvam is refused (its 2 s process-wide
  send pacing breaks the 5 s budget).
- `ONBOARDING_LLM_MODEL` — production `gemini-3.5-flash-lite`, pinned;
  reasoning models are refused at boot. Details and the API-key boot check:
  onboarding.config.prompt.md.

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
   (value `ANY`), else `classify(transcripts, interpret, state,
   classifierPromptFor(snapshot))`. Send
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

## classify(transcripts, interpret, state, prompt) → string

1. **Match pass (age and month only)** — `matchTranscripts` →
   `matchAge` / `matchMonth` in `onboarding-answer-match.ts` read the
   transcripts deterministically: digits (ASCII and Devanagari) and number
   words 0–1000 in English, English-in-Devanagari (एट, ट्वेंटी वन), Hindi
   and romanized Hindi with spelling variants; month names in English,
   Hindi and romanized Hindi, Hindu calendar months mapped to the closest
   Gregorian month (Indian national calendar: Chaitra → 4 … Phalguna → 3),
   plus 1–12 in every number form. A month name beats a number ("8 मार्च" →
   3). The pass decides only when every transcript that states a value
   agrees on exactly one, no transcript names two, and the value is in
   range. Words that are also ordinary words (one, एक, दो, do, teen, may,
   mai, march, kartik …) count only when the whole reply is answer words
   (plus filler such as जी/hmm) or they sit next to a context word (साल,
   years, महीना, month …). A match returns without calling the LLM.
2. **LLM fallback** — single `complete()` through src/interfaces/llm on the
   env provider/model: system = the state's `meta.prompt`
   (`classifierPromptFor`), user = `transcriptsMessage(texts)` (a preamble
   plus one `- <text>` line per transcript — no numbered labels, so a label
   digit can never be read as an answer), `temperatureRatio: 0`,
   `max_tokens: 200`, options `{ timeoutMs: 5000, maxAttempts: 1 }` — never
   the batch pool. An LlmError propagates (the job retries the whole turn).

`normalizeClassification(text, interpret)` post-processes the model's reply
— its formatting is never trusted, and the machine never sees raw model
text. Tolerant of a prefix, suffix or number word, but never guesses
between two candidates:

- enum: an option present as a whole word, case-insensitive ("The answer
  is yes" → YES; "nobody" / "NONE" never mean no). Exactly one DISTINCT
  option must match: "yes yes" → YES, "No, yes" → UNINTELLIGIBLE.
- integer: `readAge` — the match-pass reader without the ambiguous-word
  rule ("eight years" → 8, "आठ" → 8, "7 or 8" / "7.5" / 1001 →
  UNINTELLIGIBLE); must be within `interpret.min..max`.
- month: `readMonth` — month name or 1–12 in any form ("March (3)" → 3),
  else NONE.
- name: strip a leading `name:` / `name is` label and surrounding
  quotes/trailing period; empty, >60 chars, multi-line, `none` or
  `unintelligible` → NONE.

Logs `onboarding.classify.result state=<state> kind=<kind> method=match
outcome=<value>` or `… method=llm outcome=<value> provider=<p>
duration_ms=<n>` on every call for the UNINTELLIGIBLE rate.
Names are PII: for kind `name` the outcome is `name` or `NONE`, never the
name itself.
