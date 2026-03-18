import { setup, assign, createActor, and, not } from "xstate";
import { markWord, markLetter, markImage, detectIncorrectEndMatra, detectIncorrectMiddleMatra, detectInsertion } from "./evaluate-answer.utils";
import { identifyCharacterStatus } from "./identify-character-status.utils";
import { scoreService } from "../score/score.service";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Context {
  word: string;
  wrongCharacters: string[];
  wordErrors: number;
  imageErrors: number;
  letterImageErrors: number;
  letterNoImageErrors: number;
  answer: string | undefined;
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

// ─── Machine ──────────────────────────────────────────────────────────────────

export const machine = setup({
  types: {
    context: {} as Context,
    events: {} as Events,
  },

  guards: {
    checkAnswer: ({ context, event }, params: { fn: (args: { correctAnswer: string; studentAnswer: string }) => boolean }) => {
      if (!context.answer || !event.studentAnswer) {
        throw new Error(
          'checkAnswer guard requires context.answer and event.studentAnswer to be set',
        );
      }
      return params.fn({
        correctAnswer: context.answer,
        studentAnswer: event.studentAnswer,
      });
    }
  },

  actions: {
    increment: assign(({ context }, params: { keys: CounterKey | CounterKey[] }) => {
      const updates: Partial<Context> = {};
      for (const key of normalizeKeys(params.keys)) {
        updates[key] = context[key] + 1;
      }
      return updates;
    }),
    dropFirstWrongCharacter: assign({
      wrongCharacters: ({ context }) => context.wrongCharacters.slice(1),
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
    wrongCharacters: [],
    wordErrors: 0,
    imageErrors: 0,
    letterImageErrors: 0,
    letterNoImageErrors: 0,
    answer: input.word,
  }),

  states: {
    word: {
      entry: assign({
        answer: ({ context }) => context.word,
        wrongCharacters: () => [],
      }),
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
              ({ context }) => {
                scoreService.gradeAndRecord({
                  correct: Array.from(context.word),
                });
              },
            ]
          },
          // Student got the word correct on a subsequent try, no score change.
          {
            guard: { type: 'checkAnswer', params: { fn: markWord } },
            target: 'complete'
          },
          // Student got the word wrong three times, move on to the next word.
          {
            guard: ({ context }) => context.wordErrors >= 2,
            target: 'complete'
          },
          // The student only made an end matra error on the first attempt, mark all letters in the word as correct.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: detectIncorrectEndMatra } },
              ({ context }) => context.wordErrors === 0
            ]),
            target: 'word',
            actions: [
              { type: 'increment', params: { keys: 'wordErrors' } },
              ({ context }) => {
                scoreService.gradeAndRecord({
                  correct: Array.from(context.word),
                });
              },
            ]
          },
          // The student only made an end matra error on a subsequent try, no score change.
          {
            guard: { type: 'checkAnswer', params: { fn: detectIncorrectEndMatra } },
            target: 'word',
            actions: [
              { type: 'increment', params: { keys: 'wordErrors' } }
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
              { type: 'increment', params: { keys: 'wordErrors' } },
              ({ context }) => {
                scoreService.gradeAndRecord({
                  correct: Array.from(context.word),
                });
              },
            ]
          },
          // The student only made a middle matra error on a subsequent try, no score change.
          {
            guard: { type: 'checkAnswer', params: { fn: detectIncorrectMiddleMatra } },
            target: 'word',
            actions: [
              { type: 'increment', params: { keys: 'wordErrors' } }
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
              { type: 'increment', params: { keys: 'wordErrors' } },
              ({ context }) => {
                scoreService.gradeAndRecord({
                  correct: Array.from(context.word),
                });
              },
            ]
          },
          // The student only made an insertion error on a subsequent try, no score change.
          {
            guard: { type: 'checkAnswer', params: { fn: detectInsertion } },
            target: 'word',
            actions: [
              { type: 'increment', params: { keys: 'wordErrors' } }
            ]
          },
          // Only make the student go through the letter loop once. 
          {
            guard: ({ context }) => context.wordErrors >= 1,
            target: 'word',
            actions: 
            { type: 'increment', params: { keys: 'wordErrors' } },
          },
          // The student got one or more letters wrong on the first attempt.
          {
            guard: not({ type: 'checkAnswer', params: { fn: markWord } }),
            target: 'routeWrongLetter',
            actions: [
              { type: 'increment', params: { keys: 'wordErrors' } },
              assign({
                wrongCharacters: ({ context, event }) => {
                  const { incorrectChars } = identifyCharacterStatus({
                    correctAnswer: context.word,
                    studentAnswer: event.studentAnswer,
                  });
                  return incorrectChars;
                },
              }),
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
          guard: ({ context }) => NO_IMAGE_LETTERS.has(context.wrongCharacters[0]),
          target: 'letterNoImage',
        },
        {
          target: 'letter',
        },
      ],
    },

    letter: {
      entry: assign({
        answer: ({ context }) => context.wrongCharacters[0],
      }),
      on: {
        ANSWER: [
          // Student got the letter correct and it is the last letter in wrongCharacters, mark the letter as correct and go back to the word state.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: markLetter } },
              ({ context }) => context.wrongCharacters.length === 1
            ]),
            target: 'word',
            actions: [
              ({ context }) => {
                scoreService.gradeAndRecord({
                  correct: [context.wrongCharacters[0]],
                });
              },
              { type: 'dropFirstWrongCharacter' },
            ]
          },
          // Student got the letter correct but it isn't the last letter in wrongCharacters, mark the letter as correct and to the next letter state.
          {
            guard: { type: 'checkAnswer', params: { fn: markLetter } },
            target: 'routeWrongLetter',
            actions: [
              ({ context }) => {
                scoreService.gradeAndRecord({
                  correct: [context.wrongCharacters[0]],
                });
              },
              { type: 'dropFirstWrongCharacter' },
            ]
          },
          // Student got the letter wrong, mark the letter as incorrect and go to the image state.
          {
            guard: not({ type: 'checkAnswer', params: { fn: markLetter } }),
            target: 'image',
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

    image: {
      entry: assign({
        answer: ({ context }) => context.wrongCharacters[0],
      }),
      on: {
        ANSWER: [
          // Student got the image correct, go to the letterImage state.
          {
            guard: { type: 'checkAnswer', params: { fn: markImage } },
            target: 'letterImage',
          },
          // This is the student's second attempt, go to the letterImage state.
          {
            guard: ({ context }) => context.imageErrors >= 1,
            target: 'letterImage',
            actions: [
              { type: 'resetToZero', params: { keys: 'imageErrors' } },
            ],
          },
          // The student got the image wrong on the first attempt.
          {
            target: 'image',
            actions: [
              { type: 'increment', params: { keys: 'imageErrors' } },
            ],
          },
        ],
      },
    },

    letterNoImage: {},

    complete: {
      type: 'final',
    },
  },
});

// ─── Usage ────────────────────────────────────────────────────────────────────

const actor = createActor(machine);

actor.subscribe((snapshot) => {
  console.log("State:", snapshot.value);
});

actor.start();
