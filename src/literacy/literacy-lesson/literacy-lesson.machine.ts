import { setup, assign, createActor } from "xstate";
import { markWord } from "./evaluate-answer.utils";

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

type Events = {
  type: 'ANSWER';
  correctAnswer: string;
  incorrectAnswer: string;
}

// ─── Machine ──────────────────────────────────────────────────────────────────

export const machine = setup({
  types: {
    context: {} as Context,
    events: {} as Events,
  },

  guards: {
    checkAnswer: ({ event }, params: { fn: (args: { correctAnswer: string; studentAnswer: string }) => boolean }) => {
      if (!('correctAnswer' in event) || !('studentAnswer' in event)) {
        throw new Error(
          'checkAnswer guard requires both correctAnswer and studentAnswer on the event',
        );
      }
      return params.fn({
        correctAnswer: event.correctAnswer,
        studentAnswer: event.studentAnswer,
      });
    }
  },

  actions: {
    // myAction: assign({ ... }),
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
          {
            guard: addEventListener([
              { type: 'checkAnswer', params: { fn: markWord } },
              ({ context }) => context.wordErrors === 0
            ]),
            target: 'complete',
          },
          {
            guard: ({ context }) => context.wordErrors >= 2,
          }
        ],
      },
    },
  },
});

// ─── Usage ────────────────────────────────────────────────────────────────────

const actor = createActor(machine);

actor.subscribe((snapshot) => {
  console.log("State:", snapshot.value);
});

actor.start();
