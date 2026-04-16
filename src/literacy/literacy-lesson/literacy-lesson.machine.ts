import { setup, assign, and, not } from "xstate";
import { markWord, markLetter, markImage, detectIncorrectEndMatra, detectIncorrectMiddleMatra, detectInsertion } from "./evaluate-answer.utils";
import { identifyCharacterStatus } from "./identify-character-status.utils";

// ─── Constants ───────────────────────────────────────────────────────────────

export const WELCOME_MESSAGE_STATE_TRANSITION_ID = 'welcome-message';
export const AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID = 'audio-only-request';
export const STALE_LESSON_RESTART_STATE_TRANSITION_ID = 'stale-lesson-restart';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Context {
  word: string;
  wrongLetters: string[];
  wordErrors: number;
  imageErrors: number;
  letterErrors: number;
  letterImageErrors: number;
  letterNoImageErrors: number;
  answer: string | undefined;
  answerCorrect: boolean | null;
  stateTransitionId: string;
  userMessageId: string;
  pendingCorrect: string[];
  pendingIncorrect: string[];
}

type CounterKey = keyof {
  [K in keyof Context as Context[K] extends number ? K : never]: true;
};

function normalizeKeys(keys: CounterKey | CounterKey[]): CounterKey[] {
  return Array.isArray(keys) ? keys : [keys];
}

type Events = {
  type: 'ANSWER';
  studentAnswer: string;
}

const NO_IMAGE_LETTERS = new Set(['ञ', 'ण']);

// ─── Machine ─────────────────────────────────────────────────────────────────

export const machine = setup({
  types: {
    context: {} as Context,
    events: {} as Events,
    input: {} as { word: string; userMessageId: string },
  },

  guards: {
    checkAnswer: ({ context, event }, params: { fn: (args: { correctAnswer: string; studentAnswer: string }) => boolean }) => {
      if (!context.answer || !event.studentAnswer) {
        throw new Error(
          'checkAnswer guard requires context.answer and event.studentAnswer to be set',
        );
      }
      const result = params.fn({
        correctAnswer: context.answer,
        studentAnswer: event.studentAnswer,
      });
      return result;
    }
  },

  actions: {
    clearPendingScores: assign({
      pendingCorrect: () => [],
      pendingIncorrect: () => [],
    }),
    increment: assign(({ context }, params: { keys: CounterKey | CounterKey[] }) => {
      const updates: Partial<Context> = {};
      for (const key of normalizeKeys(params.keys)) {
        updates[key] = context[key] + 1;
      }
      return updates;
    }),
    dropFirstWrongLetter: assign({
      wrongLetters: ({ context }) => context.wrongLetters.slice(1),
    }),
    resetToZero: assign(({ context }, params: { keys: CounterKey | CounterKey[] }) => {
      const updates: Partial<Context> = {};
      for (const key of normalizeKeys(params.keys)) {
        updates[key] = 0;
      }
      return updates;
    }),
  },
}).createMachine({
  id: "literacy-lesson",
  initial: "word",

  context: ({ input }) => ({
    word: input.word,
    wrongLetters: [],
    wordErrors: 0,
    imageErrors: 0,
    letterErrors: 0,
    letterImageErrors: 0,
    letterNoImageErrors: 0,
    answer: input.word,
    answerCorrect: null,
    stateTransitionId: `${input.word}-start-word-initial`,
    userMessageId: input.userMessageId,
    pendingCorrect: [],
    pendingIncorrect: [],
  }),

  states: {
    word: {
      entry: [
        assign({
          answer: ({ context }) => context.word,
          wrongLetters: () => [],
        }),
      ],
      on: {
        ANSWER: [
          // Student got the word correct on the first try, mark all letters in the word as correct.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: markWord } },
              ({ context }) => context.wordErrors === 0
            ]),
            target: 'complete',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => true }),
              assign({ stateTransitionId: ({ context }) => `${context.word}-word-complete-correct-first` }),
              assign({ pendingCorrect: ({ context }) => Array.from(context.word) }),
            ]
          },
          // Student got the word correct on a subsequent try, no score change.
          {
            guard: { type: 'checkAnswer', params: { fn: markWord } },
            target: 'complete',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => true }),
              assign({ stateTransitionId: ({ context }) => `${context.word}-word-complete-correct-retry` }),
            ]
          },
          // Student got the word wrong three times, move on to the next word.
          {
            guard: ({ context }) => context.wordErrors >= 2,
            target: 'complete',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.word}-word-complete-maxErrors` }),
            ]
          },
          // The student only made an end matra error on the first attempt, mark all letters in the word as correct.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: detectIncorrectEndMatra } },
              ({ context }) => context.wordErrors === 0
            ]),
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.word}-word-word-endMatra-first` }),
              { type: 'increment', params: { keys: 'wordErrors' } },
              assign({ pendingCorrect: ({ context }) => Array.from(context.word) }),
            ]
          },
          // The student only made an end matra error on a subsequent try, no score change.
          {
            guard: { type: 'checkAnswer', params: { fn: detectIncorrectEndMatra } },
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.word}-word-word-endMatra-retry` }),
              { type: 'increment', params: { keys: 'wordErrors' } },
            ]
          },
          // The student only made a middle matra error on the first attempt, mark all letters in the word as correct.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: detectIncorrectMiddleMatra } },
              ({ context }) => context.wordErrors === 0
            ]),
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.word}-word-word-middleMatra-first` }),
              { type: 'increment', params: { keys: 'wordErrors' } },
              assign({ pendingCorrect: ({ context }) => Array.from(context.word) }),
            ]
          },
          // The student only made a middle matra error on a subsequent try, no score change.
          {
            guard: { type: 'checkAnswer', params: { fn: detectIncorrectMiddleMatra } },
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.word}-word-word-middleMatra-retry` }),
              { type: 'increment', params: { keys: 'wordErrors' } },
            ]
          },
          // The student only made an insertion error on the first attempt, mark all letters in the word as correct.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: detectInsertion } },
              ({ context }) => context.wordErrors === 0
            ]),
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.word}-word-word-insertion-first` }),
              { type: 'increment', params: { keys: 'wordErrors' } },
              assign({ pendingCorrect: ({ context }) => Array.from(context.word) }),
            ]
          },
          // The student only made an insertion error on a subsequent try, no score change.
          {
            guard: { type: 'checkAnswer', params: { fn: detectInsertion } },
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.word}-word-word-insertion-retry` }),
              { type: 'increment', params: { keys: 'wordErrors' } },
            ]
          },
          // Only make the student go through the letter loop once. 
          {
            guard: ({ context }) => context.wordErrors >= 1,
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.word}-word-word-loopBack` }),
              { type: 'increment', params: { keys: 'wordErrors' } },
            ],
          },
          // The student got one or more letters wrong on the first attempt.
          {
            guard: not({ type: 'checkAnswer', params: { fn: markWord } }),
            target: 'routeWrongLetter',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              { type: 'increment', params: { keys: 'wordErrors' } },
              assign({
                wrongLetters: ({ context, event }) => {
                  const { incorrectChars } = identifyCharacterStatus({
                    correctAnswer: context.word,
                    studentAnswer: event.studentAnswer,
                  });
                  return incorrectChars;
                },
              }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-word-routeWrongLetter-drillLetters` }),
            ],
          },
          // This transition should never be reached — all cases are handled above.
          {
            actions: () => {
              throw new Error(
                'Unhandled ANSWER transition in word state — this should be unreachable',
              );
            },
          }
        ],
      },
    },

    routeWrongLetter: {
      always: [
        {
          guard: ({ context }) => NO_IMAGE_LETTERS.has(context.wrongLetters[0]),
          target: 'letterNoImage',
        },
        {
          target: 'letter',
        },
      ],
    },

    letter: {
      entry: [
        assign({ answer: ({ context }) => context.wrongLetters[0] }),
      ],
      on: {
        ANSWER: [
          // Student got the letter correct and it is the last letter in wrongLetters, mark the letter as correct and go back to the word state.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: markLetter } },
              ({ context }) => context.wrongLetters.length === 1
            ]),
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => true }),
              assign({ stateTransitionId: ({ context }) => `${context.word}-letter-word-correct-last` }),
              assign({ pendingCorrect: ({ context }) => [context.wrongLetters[0]] }),
              { type: 'dropFirstWrongLetter' },
            ]
          },
          // Student got the letter correct but it isn't the last letter in wrongLetters, mark the letter as correct and to the next letter state.
          {
            guard: { type: 'checkAnswer', params: { fn: markLetter } },
            target: 'routeWrongLetter',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => true }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[1]}-letter-routeWrongLetter-correct-more` }),
              assign({ pendingCorrect: ({ context }) => [context.wrongLetters[0]] }),
              { type: 'dropFirstWrongLetter' },
            ]
          },
          // Student got the letter wrong, mark the letter as incorrect and go to the image state.
          {
            guard: not({ type: 'checkAnswer', params: { fn: markLetter } }),
            target: 'image',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-letter-image-wrong` }),
              assign({ pendingIncorrect: ({ context }) => [context.wrongLetters[0]] }),
            ]
          },
          // This transition should never be reached — all cases are handled above.
          {
            actions: () => {
              throw new Error(
                'Unhandled ANSWER transition in letter state — this should be unreachable',
              );
            },
          }
        ]
      },
    },

    image: {
      entry: [
        assign({ answer: ({ context }) => context.wrongLetters[0] }),
      ],
      on: {
        ANSWER: [
          // Student got the image correct, go to the letterImage state.
          {
            guard: { type: 'checkAnswer', params: { fn: markImage } },
            target: 'letterImage',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => true }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-image-letterImage-correct` }),
            ],
          },
          // This is the student's second attempt, go to the letterImage state.
          {
            guard: ({ context }) => context.imageErrors >= 1,
            target: 'letterImage',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-image-letterImage-maxErrors` }),
              { type: 'resetToZero', params: { keys: 'imageErrors' } },
            ],
          },
          // The student got the image wrong on the first attempt.
          {
            target: 'image',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-image-image-wrong-first` }),
              { type: 'increment', params: { keys: 'imageErrors' } },
            ],
          },
        ],
      },
    },

    letterImage: {
      entry: [
        assign({ answer: ({ context }) => context.wrongLetters[0] }),
      ],
      on: {
        ANSWER: [
          // Student got the letter correct and it is the last letter in wrongLetters, go back to the word state.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: markLetter } },
              ({ context }) => context.wrongLetters.length === 1
            ]),
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => true }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-letterImage-word-correct-last` }),
              { type: 'dropFirstWrongLetter' },
            ]
          },
          // Student got the letter correct but it isn't the last letter in wrongLetters, go to the next letter state.
          {
            guard: { type: 'checkAnswer', params: { fn: markLetter } },
            target: 'routeWrongLetter',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => true }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[1]}-letterImage-routeWrongLetter-correct-more` }),
              { type: 'dropFirstWrongLetter' },
            ]
          },
          // Student got the letter wrong, it is their first attempt.
          {
            guard: ({ context }) => context.letterErrors === 0,
            target: 'letterImage',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-letterImage-letterImage-wrong-first` }),
              { type: 'increment', params: { keys: 'letterErrors' } },
            ]
          },
          // Student got the letter wrong, it is their second attempt.
          {
            guard: ({ context }) => context.letterErrors === 1,
            target: 'letterImage',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-letterImage-letterImage-wrong-second` }),
              { type: 'increment', params: { keys: 'letterErrors' } },
            ]
          },
          // Student got the letter wrong three times, it is the last letter in wrongLetters.
          {
            guard: and([
              ({ context }) => context.letterErrors >= 2,
              ({ context }) => context.wrongLetters.length === 1
            ]),
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-letterImage-word-maxErrors-last` }),
              { type: 'resetToZero', params: { keys: 'letterErrors' } },
              { type: 'dropFirstWrongLetter' },
            ]
          },
          // Student got the letter wrong three times, more letters remain.
          {
            guard: and([
              ({ context }) => context.letterErrors >= 2,
              ({ context }) => context.wrongLetters.length > 1
            ]),
            target: 'routeWrongLetter',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[1]}-letterImage-routeWrongLetter-maxErrors-more` }),
              { type: 'resetToZero', params: { keys: 'letterErrors' } },
              { type: 'dropFirstWrongLetter' },
            ]
          },
          // This transition should never be reached — all cases are handled above.
          {
            actions: () => {
              throw new Error(
                'Unhandled ANSWER transition in letterImage state — this should be unreachable',
              );
            },
          }
        ]
      },
    },

    letterNoImage: {
      entry: [
        assign({ answer: ({ context }) => context.wrongLetters[0] }),
      ],
      on: {
        ANSWER: [
          // Student got the letter correct first go and it is the last letter in wrongLetters, mark the letter as correct and go back to the word state.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: markLetter } },
              ({ context }) => context.letterNoImageErrors === 0,
              ({ context }) => context.wrongLetters.length === 1
            ]),
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => true }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-letterNoImage-word-correct-first-last` }),
              assign({ pendingCorrect: ({ context }) => [context.wrongLetters[0]] }),
              { type: 'dropFirstWrongLetter' },
            ]
          },
          // Student got the letter correct first go but it isn't the last letter in wrongLetters, mark the letter as correct and go to the routeWrongLetter state.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: markLetter } },
              ({ context }) => context.letterNoImageErrors === 0,
              ({ context }) => context.wrongLetters.length >= 2,
            ]),
            target: 'routeWrongLetter',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => true }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[1]}-letterNoImage-routeWrongLetter-correct-first-more` }),
              assign({ pendingCorrect: ({ context }) => [context.wrongLetters[0]] }),
              { type: 'dropFirstWrongLetter' },
            ]
          },
          // Student got the letter correct second go and it is the last letter in wrongLetters, go back to the word state.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: markLetter } },
              ({ context }) => context.letterNoImageErrors >= 1,
              ({ context }) => context.wrongLetters.length === 1
            ]),
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => true }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-letterNoImage-word-correct-retry-last` }),
              { type: 'dropFirstWrongLetter' },
              { type: 'resetToZero', params: { keys: 'letterNoImageErrors' } },
            ]
          },
          // Student got the letter correct second go but it isn't the last letter in wrongLetters, go to the routeWrongLetter state.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: markLetter } },
              ({ context }) => context.letterNoImageErrors >= 1,
              ({ context }) => context.wrongLetters.length >= 2,
            ]),
            target: 'routeWrongLetter',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => true }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[1]}-letterNoImage-routeWrongLetter-correct-retry-more` }),
              { type: 'dropFirstWrongLetter' },
              { type: 'resetToZero', params: { keys: 'letterNoImageErrors' } },
            ]
          },
          // Student got the letter wrong first go, mark the letter as incorrect and go to the letterNoImage state.
          {
            guard: and([
              ({ context }) => context.letterNoImageErrors === 0,
            ]),
            target: 'letterNoImage',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-letterNoImage-letterNoImage-wrong-first` }),
              assign({ pendingIncorrect: ({ context }) => [context.wrongLetters[0]] }),
              { type: 'increment', params: { keys: 'letterNoImageErrors' } },
            ]
          },
          // Student got the letter wrong second go and it is the last letter in wrongLetters, go to the word state.
          {
            guard: and([
              ({ context }) => context.letterNoImageErrors >= 1,
              ({ context }) => context.wrongLetters.length === 1,
            ]),
            target: 'word',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[0]}-letterNoImage-word-wrong-last` }),
              { type: 'dropFirstWrongLetter' },
              { type: 'resetToZero', params: { keys: 'letterNoImageErrors' } },
            ]
          },
          // Student got the letter wrong second go and it is not the last letter in wrongLetters, go to the routeWrongLetter state.
          {
            guard: and([
              ({ context }) => context.letterNoImageErrors >= 1,
              ({ context }) => context.wrongLetters.length >= 2,
            ]),
            target: 'routeWrongLetter',
            actions: [
              { type: 'clearPendingScores' },
              assign({ answerCorrect: () => false }),
              assign({ stateTransitionId: ({ context }) => `${context.wrongLetters[1]}-letterNoImage-routeWrongLetter-wrong-more` }),
              { type: 'dropFirstWrongLetter' },
              { type: 'resetToZero', params: { keys: 'letterNoImageErrors' } },
            ]
          },
          // This transition should never be reached — all cases are handled above.
          {
            actions: () => {
              throw new Error(
                'Unhandled ANSWER transition in letterNoImage state — this should be unreachable',
              );
            },
          }
        ]
      },
    },

    complete: {
      type: 'final',
    },
  },
});
