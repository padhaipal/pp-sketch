# onboarding.machine.ts — parent onboarding state machine

XState 5, pure (no side-effecting actions), persisted like the literacy
machine: OnboardingService stores `actor.getPersistedSnapshot()` as
`onboarding_states.snapshot` and restores it with `createActor(machine,
{ snapshot })`. The machine never touches the DB or the classifier.

## Context

- `stateTransitionIds: string[]` — reset on EVERY transition (the `emit`
  action assigns, never appends). The outbound media for this turn only.
  Initial value: `['onboarding-ask-guardian']`.
- `birthYear`, `birthMonth`, `studentName` — null until gathered.

## Event

One event, `REPLY { value, istYear }`. `value` is the classifier's
normalized output for the current state's Interpret (see
onboarding.service.prompt.md → normalizeClassification): an enum option in
UPPER CASE, an integer string, a month-number string, a name, `NONE` or
`UNINTELLIGIBLE`. `istYear` is the current calendar year in Asia/Kolkata
(supplied by the service so the machine stays pure) — birthYear = istYear −
age.

## meta.interpret

Every state declares `meta: { interpret }` — how the service must read the
parent's reply while in that state. Options live ONLY here, never in DB
rows. `interpretFor(snapshot)` reads it off `snapshot.getMeta()`
(`${machine.id}.${state}`) and throws for a state without meta.

| kind      | shape                       | classifier output set          |
| --------- | --------------------------- | ------------------------------ |
| `enum`    | `{ options: string[] }`     | one option (upper) or UNINTELLIGIBLE |
| `integer` | `{ min: 3, max: 18 }`       | digits or UNINTELLIGIBLE       |
| `month`   | —                           | `1`–`12` or NONE               |
| `name`    | —                           | the name or NONE               |
| `none`    | —                           | not classified (`ANY`)         |

## States and transitions (stid emitted → target)

Every state's own prompt stid is `onboarding-<state-kebab>`. UNINTELLIGIBLE
in any classifying state is an internal self-transition emitting
`['onboarding-unintelligible', '<that state's prompt stid>']` so the
question is repeated.

- **askGuardian** (enum yes/no) — prompt `onboarding-ask-guardian`
  - YES → askConsent, `onboarding-ask-consent`
  - NO → self, `onboarding-ask-guardian-retry`
- **askConsent** (enum yes/no/information) — prompt `onboarding-ask-consent`
  - YES → askName, `onboarding-ask-name`
  - INFORMATION → self, `onboarding-consent-info`
  - NO → consentRefused, `onboarding-consent-refused`
- **consentRefused** (enum yes/no) — prompt `onboarding-consent-refused`
  - YES → askConsent, `onboarding-consent-info` (re-explain, then ask again)
  - NO → declined, `onboarding-declined`
- **declined** (none) — prompt `onboarding-declined`. NOT final: the user
  stays un-onboarded; any later voice note → askConsent,
  `onboarding-ask-consent`.
- **askName** (name) — prompt `onboarding-ask-name`. Any reply → askAge,
  `onboarding-ask-age`; studentName = value, or null on NONE. Never
  UNINTELLIGIBLE.
- **askAge** (integer 3–18) — prompt `onboarding-ask-age`
  - valid → askMonth, `onboarding-ask-month`; birthYear = istYear − age
  - UNINTELLIGIBLE → self, `['onboarding-unintelligible', 'onboarding-ask-age']`
  - any other integer → self, `onboarding-ask-age-retry`
- **askMonth** (month) — prompt `onboarding-ask-month`. Any reply → done,
  `onboarding-complete`; birthMonth = 1–12, else null.
- **done** — final (`snapshot.status === 'done'`). The service writes the
  user's columns in the same transaction as this row.

## Full stid list (12)

onboarding-ask-guardian, -ask-guardian-retry, -ask-consent, -consent-info,
-consent-refused, -declined, -ask-name, -ask-age, -ask-age-retry,
-ask-month, -complete, -unintelligible — exported as `ONBOARDING_STIDS`.
pp-dashboard hardcodes the same list (src/app/media-metadata/types.ts,
NON_LESSON_STIDS); keep in sync by hand. Prompt media for each must be
seeded — an unseeded stid sends nothing (the processor WARNs).
