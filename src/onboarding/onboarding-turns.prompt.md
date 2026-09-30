# onboarding-turns.ts — read-side description of onboarding turns

Pure. `describeOnboardingTurns(rowsOldestFirst)` takes every
`onboarding_states` row of ONE user (oldest first) and returns, per
`user_message_id`, an `OnboardingTurn` for the staff `/user/:id` page
(`GET users/:id/media?onboarding=1`, user.dto.prompt.md).

Why derived: a row stores only the machine snapshot AFTER the turn. The
classifier's reading of the parent's reply (yes / no / information /
unintelligible / the age) is logged, never persisted, and the gathered
values sit in the snapshot context until the completing turn writes them to
the user. Everything is recovered from each row and the one before it, so it
works for all history with no schema change.

- `question` — the state BEFORE the turn (the question answered). Null on a
  start row: the first turn, or a restart after an unrestorable snapshot
  (askGuardian with exactly `['onboarding-ask-guardian']` — a NO emits
  `-ask-guardian-retry`, an unclear reply emits two stids).
- `next` — the state after (`done` when complete).
- `understood` — first stid `onboarding-unintelligible` → `UNINTELLIGIBLE`;
  otherwise by transition: askGuardian → askConsent YES, else NO;
  askConsent → askName YES, → consentRefused NO, else INFORMATION;
  consentRefused → askConsent YES, else NO; askName → the name or `NONE`;
  askAge → the age = (IST year of the row's `created_at`) − `birthYear`;
  askMonth → the month number or `NONE`; declined → null (any reply
  re-opens consent, nothing is read).
- `saved` — what the turn added to the onboarding record: `name`,
  `birth_year`, `birth_month`.
- `completed` — the `done` turn: birth year/month, the recording-permission
  timestamp (the time of THIS turn, not of the consent reply) and the name
  (when heard) were written to the user in the same transaction.

The spec drives the real machine, so the derivation cannot drift from the
transitions.
