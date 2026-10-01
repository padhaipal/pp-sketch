# hail-mary.processor.ts — the 23h55m re-engagement message

`rearmHailMary({ user_id, user_external_id, user_message_id, otel_carrier })`
is called on every inbound lesson turn (voice note or comprehension flow
tap — inbound.utils `rearmHailMaryBestEffort`): it removes the user's
pending job and adds one delayed `HAIL_MARY_DELAY_MS` (23h55m) with the
stable id `hailMaryJobId(user_id)` = `hail-mary-<user id>` (hyphen: BullMQ
rejects a custom id containing ':' — the old `hail-mary:<id>` threw on every
turn from 2026-07 to 2026-10 and the timer never armed). User activity is the
only thing that re-arms it; a send never does.

`processHailMaryJob` (worker in main.ts, concurrency 32):
1. Latest whatsapp `media_metadata` row for the user (`rolled_back = false`;
   voice notes AND taps). None → skip.
2. Not the job's message → the chain moved on: re-arm against the latest
   message unless a delayed job already exists (the active job itself does
   not count). Skip.
3. Latest message ≥ 24h old (clock skew past the delay) → skip.
4. Media: the `hail-mary` stid's video (if seeded) + the next lesson's prompt
   from `processAnswer({ user, user_message_id: latest.id })` (a fresh lesson
   after the 15-minute staleness) + its runtime sentence text; each step
   tolerant. Nothing to send → skip.
5. Sent through `WabotOutboundService.sendNotification` — the same path as
   evening-reminder / morning-update. NOT `sendMessage`: that first claims
   the inflight record wabot keeps for a message the user just sent, which
   does not exist here, so it answered `delivered:false` and nothing ever went
   out (second half of the 2026-10 fix). Outcomes, as in
   evening-reminder.processor.ts: `error_code 130429` (rate limit) → throw,
   retried on the queue's backoff (HAIL_MARY in queues.ts = NOTIFIER_SEND's:
   5 attempts, exponential from 3 s); `131047` (24-hour window closed) → warn
   + skip; `delivered:false` → throw (a failed job, visible in the logs);
   delivered → `outboundMessages.recordSent` with trigger `hail-mary` (only
   then — a 2xx without delivery used to be recorded as sent).

Deploying the 2026-10 fix switches this message ON in production for the
first time: every user who goes quiet for 23h55m after their next message
gets it.
