import { setup, assign } from 'xstate';
import { MAX_AGE, MIN_AGE } from './onboarding-answer-match';

export { MAX_AGE, MIN_AGE };

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
  askMonth: 'onboarding-ask-month',
  complete: 'onboarding-complete',
  unintelligible: 'onboarding-unintelligible',
} as const;

export const UNINTELLIGIBLE = 'UNINTELLIGIBLE';
export const NONE = 'NONE';

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
  // System prompt for the LLM fallback; every classifying state has one.
  prompt?: string;
}

// The parent's transcripts reach the LLM as an unnumbered list (see
// OnboardingService.classify), so no label digit can be read as an answer.
const PROMPTS = {
  askGuardian:
    "A parent on WhatsApp was asked whether they are this child's parent or guardian. Reply with exactly one word: yes if they say they are the child's parent or guardian, no if they say they are not, or UNINTELLIGIBLE if the reply is unclear, off-topic, or says both.",
  askConsent:
    "A parent on WhatsApp was asked whether PadhaiPal may record and keep their child's voice notes. Reply with exactly one word: yes if they agree, no if they refuse, information if they ask a question or want to know more before deciding, or UNINTELLIGIBLE if the reply is unclear or off-topic.",
  consentRefused:
    "A parent on WhatsApp refused permission to record their child's voice notes and was then asked whether they would like to hear more before deciding. Reply with exactly one word: yes if they want to hear more, no if they do not, or UNINTELLIGIBLE if the reply is unclear or off-topic.",
  askName:
    "A parent on WhatsApp was asked their child's name. Reply with only the child's name, written in the script it appears in. If the reply gives no name, reply NONE.",
  askAge:
    "A parent on WhatsApp was asked how old their child is. Reply with the child's age in whole years as digits only, for example 8. The age may be spoken as a word in Hindi or English. Round a half year down (साढ़े सात is 7). Convert an age given in months to whole years (18 महीने is 1). If the reply does not state exactly one age, reply UNINTELLIGIBLE.",
  askMonth:
    'A parent on WhatsApp was asked which month their child was born in. Reply with the month as a number from 1 to 12, where January is 1 and December is 12. The month may be an English or Hindi month name, or a number. A Hindu calendar month becomes the closest month: Chaitra 4, Vaishakh 5, Jyeshtha 6, Ashadh 7, Shravan 8, Bhadrapad 9, Ashwin 10, Kartik 11, Margashirsha 12, Paush 1, Magh 2, Phalgun 3. If the reply gives no month or the parent does not know, reply NONE.',
} as const;

const YES_NO: Interpret = { kind: 'enum', options: ['yes', 'no'] };

function ageOf(value: string): number | null {
  if (!/^\d{1,4}$/.test(value)) return null;
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
      meta: { interpret: YES_NO, prompt: PROMPTS.askGuardian },
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
        prompt: PROMPTS.askConsent,
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
      meta: { interpret: YES_NO, prompt: PROMPTS.consentRefused },
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
      meta: { interpret: { kind: 'name' }, prompt: PROMPTS.askName },
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

    // Any age MIN_AGE..MAX_AGE is accepted; there is no plausibility range.
    askAge: {
      meta: {
        interpret: { kind: 'integer', min: MIN_AGE, max: MAX_AGE },
        prompt: PROMPTS.askAge,
      },
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
          // UNINTELLIGIBLE, or anything that is not an age in range.
          {
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
        ],
      },
    },

    // Any reply completes; a month outside 1–12 (or NONE) leaves it null.
    askMonth: {
      meta: { interpret: { kind: 'month' }, prompt: PROMPTS.askMonth },
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
type MetaSource = {
  value: unknown;
  getMeta: () => Record<string, StateMeta | undefined>;
};

function metaFor(snapshot: MetaSource): StateMeta {
  const state = String(snapshot.value);
  const meta = snapshot.getMeta()[`${machine.id}.${state}`];
  if (!meta) {
    throw new Error(`onboarding state ${state} declares no meta.interpret`);
  }
  return meta;
}

export function interpretFor(snapshot: MetaSource): Interpret {
  return metaFor(snapshot).interpret;
}

// The LLM system prompt for the current state's question.
export function classifierPromptFor(snapshot: MetaSource): string {
  const { prompt } = metaFor(snapshot);
  if (!prompt) {
    throw new Error(
      `onboarding state ${String(snapshot.value)} declares no meta.prompt`,
    );
  }
  return prompt;
}
