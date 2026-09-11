import { setup, assign } from 'xstate';

// ─── Constants ───────────────────────────────────────────────────────────────

// Every stid this machine can emit. pp-dashboard hardcodes the same list in
// src/app/media-metadata/types.ts (NON_LESSON_STIDS) — keep in sync by hand.
export const ONBOARDING_STIDS = {
  askGuardian: 'onboarding-ask-guardian',
  askGuardianRetry: 'onboarding-ask-guardian-retry',
  askConsent: 'onboarding-ask-consent',
  consentInfo: 'onboarding-consent-info',
  consentRefused: 'onboarding-consent-refused',
  declined: 'onboarding-declined',
  askName: 'onboarding-ask-name',
  askAge: 'onboarding-ask-age',
  askAgeRetry: 'onboarding-ask-age-retry',
  askMonth: 'onboarding-ask-month',
  complete: 'onboarding-complete',
  unintelligible: 'onboarding-unintelligible',
} as const;

export const UNINTELLIGIBLE = 'UNINTELLIGIBLE';
export const NONE = 'NONE';
export const MIN_AGE = 3;
export const MAX_AGE = 18;

// ─── Types ────────────────────────────────────────────────────────────────────

// How OnboardingService.classify must read the parent's reply in a state.
// Options live only here, never in DB rows.
export type Interpret =
  | { kind: 'enum'; options: readonly string[] }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'month' }
  | { kind: 'name' }
  | { kind: 'none' };

export type OnboardingStateName =
  | 'askGuardian'
  | 'askConsent'
  | 'consentRefused'
  | 'declined'
  | 'askName'
  | 'askAge'
  | 'askMonth'
  | 'done';

interface Context {
  // Reset on every transition — the outbound media for THIS turn only.
  stateTransitionIds: string[];
  birthYear: number | null;
  birthMonth: number | null;
  studentName: string | null;
}

// The classifier's normalized output for the current state's Interpret:
// an enum option (upper-cased), an integer string, a month number string,
// a name, UNINTELLIGIBLE, or NONE. `istYear` is the current year in
// Asia/Kolkata, supplied by the service so the machine stays pure.
type ReplyEvent = { type: 'REPLY'; value: string; istYear: number };

interface StateMeta {
  interpret: Interpret;
}

const YES_NO: Interpret = { kind: 'enum', options: ['yes', 'no'] };

function ageOf(value: string): number | null {
  if (!/^\d{1,3}$/.test(value)) return null;
  const age = parseInt(value, 10);
  return age >= MIN_AGE && age <= MAX_AGE ? age : null;
}

function monthOf(value: string): number | null {
  if (!/^\d{1,2}$/.test(value)) return null;
  const month = parseInt(value, 10);
  return month >= 1 && month <= 12 ? month : null;
}

// ─── Machine ─────────────────────────────────────────────────────────────────

export const machine = setup({
  types: {
    context: {} as Context,
    events: {} as ReplyEvent,
    meta: {} as StateMeta,
  },
  guards: {
    is: ({ event }, params: { value: string }) => event.value === params.value,
    validAge: ({ event }) => ageOf(event.value) !== null,
  },
  actions: {
    emit: assign((_, params: { stids: string[] }) => ({
      stateTransitionIds: params.stids,
    })),
  },
}).createMachine({
  id: 'onboarding',
  initial: 'askGuardian',
  context: {
    stateTransitionIds: [ONBOARDING_STIDS.askGuardian],
    birthYear: null,
    birthMonth: null,
    studentName: null,
  },
  states: {
    // "Are you the child's parent/guardian?"
    askGuardian: {
      meta: { interpret: YES_NO },
      on: {
        REPLY: [
          {
            guard: { type: 'is', params: { value: 'YES' } },
            target: 'askConsent',
            actions: {
              type: 'emit',
              params: { stids: [ONBOARDING_STIDS.askConsent] },
            },
          },
          {
            guard: { type: 'is', params: { value: 'NO' } },
            actions: {
              type: 'emit',
              params: { stids: [ONBOARDING_STIDS.askGuardianRetry] },
            },
          },
          {
            actions: {
              type: 'emit',
              params: {
                stids: [
                  ONBOARDING_STIDS.unintelligible,
                  ONBOARDING_STIDS.askGuardian,
                ],
              },
            },
          },
        ],
      },
    },

    // "May we record and keep your child's voice notes?" — yes / no / tell
    // me more.
    askConsent: {
      meta: {
        interpret: { kind: 'enum', options: ['yes', 'no', 'information'] },
      },
      on: {
        REPLY: [
          {
            guard: { type: 'is', params: { value: 'YES' } },
            target: 'askName',
            actions: {
              type: 'emit',
              params: { stids: [ONBOARDING_STIDS.askName] },
            },
          },
          {
            guard: { type: 'is', params: { value: 'INFORMATION' } },
            actions: {
              type: 'emit',
              params: { stids: [ONBOARDING_STIDS.consentInfo] },
            },
          },
          {
            guard: { type: 'is', params: { value: 'NO' } },
            target: 'consentRefused',
            actions: {
              type: 'emit',
              params: { stids: [ONBOARDING_STIDS.consentRefused] },
            },
          },
          {
            actions: {
              type: 'emit',
              params: {
                stids: [
                  ONBOARDING_STIDS.unintelligible,
                  ONBOARDING_STIDS.askConsent,
                ],
              },
            },
          },
        ],
      },
    },

    // "Would you like to hear more before deciding?" — yes re-explains and
    // asks again; no declines.
    consentRefused: {
      meta: { interpret: YES_NO },
      on: {
        REPLY: [
          {
            guard: { type: 'is', params: { value: 'YES' } },
            target: 'askConsent',
            actions: {
              type: 'emit',
              params: { stids: [ONBOARDING_STIDS.consentInfo] },
            },
          },
          {
            guard: { type: 'is', params: { value: 'NO' } },
            target: 'declined',
            actions: {
              type: 'emit',
              params: { stids: [ONBOARDING_STIDS.declined] },
            },
          },
          {
            actions: {
              type: 'emit',
              params: {
                stids: [
                  ONBOARDING_STIDS.unintelligible,
                  ONBOARDING_STIDS.consentRefused,
                ],
              },
            },
          },
        ],
      },
    },

    // Not final: the user stays un-onboarded and any later voice note
    // re-opens the consent question.
    declined: {
      meta: { interpret: { kind: 'none' } },
      on: {
        REPLY: {
          target: 'askConsent',
          actions: {
            type: 'emit',
            params: { stids: [ONBOARDING_STIDS.askConsent] },
          },
        },
      },
    },

    // Any reply advances; NONE leaves the name null. Never UNINTELLIGIBLE.
    askName: {
      meta: { interpret: { kind: 'name' } },
      on: {
        REPLY: {
          target: 'askAge',
          actions: [
            assign({
              studentName: ({ event }) =>
                event.value === NONE ? null : event.value,
            }),
            { type: 'emit', params: { stids: [ONBOARDING_STIDS.askAge] } },
          ],
        },
      },
    },

    askAge: {
      meta: { interpret: { kind: 'integer', min: MIN_AGE, max: MAX_AGE } },
      on: {
        REPLY: [
          {
            guard: 'validAge',
            target: 'askMonth',
            actions: [
              assign({
                birthYear: ({ event }) => event.istYear - ageOf(event.value)!,
              }),
              { type: 'emit', params: { stids: [ONBOARDING_STIDS.askMonth] } },
            ],
          },
          {
            guard: { type: 'is', params: { value: UNINTELLIGIBLE } },
            actions: {
              type: 'emit',
              params: {
                stids: [
                  ONBOARDING_STIDS.unintelligible,
                  ONBOARDING_STIDS.askAge,
                ],
              },
            },
          },
          // An integer outside MIN_AGE..MAX_AGE.
          {
            actions: {
              type: 'emit',
              params: { stids: [ONBOARDING_STIDS.askAgeRetry] },
            },
          },
        ],
      },
    },

    // Any reply completes; a month outside 1–12 (or NONE) leaves it null.
    askMonth: {
      meta: { interpret: { kind: 'month' } },
      on: {
        REPLY: {
          target: 'done',
          actions: [
            assign({ birthMonth: ({ event }) => monthOf(event.value) }),
            { type: 'emit', params: { stids: [ONBOARDING_STIDS.complete] } },
          ],
        },
      },
    },

    // Reaching this final state makes the persisted snapshot's status
    // 'done'; OnboardingService writes the user's columns in the same
    // transaction as the row.
    done: {
      type: 'final',
      meta: { interpret: { kind: 'none' } },
    },
  },
});

export type OnboardingSnapshot = ReturnType<typeof machine.resolveState>;

// The current state's Interpret, read from the machine's meta so the
// service never hardcodes per-state parsing rules.
export function interpretFor(snapshot: {
  value: unknown;
  getMeta: () => Record<string, StateMeta | undefined>;
}): Interpret {
  const state = String(snapshot.value);
  const meta = snapshot.getMeta()[`${machine.id}.${state}`];
  if (!meta) {
    throw new Error(`onboarding state ${state} declares no meta.interpret`);
  }
  return meta.interpret;
}
