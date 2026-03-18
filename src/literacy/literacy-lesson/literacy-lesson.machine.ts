import { setup, assign, createActor, and } from "xstate";
import { markWord, detectIncorrectEndMatra, detectIncorrectMiddleMatra, detectInsertion } from "./evaluate-answer.utils";
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
          // Student got the word correct on the first try, mark all letters in the word as correct..
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
              ({ context }) => {
                scoreService.gradeAndRecord({
                  correct: Array.from(context.word),
                });
              },
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
              ({ context }) => {
                scoreService.gradeAndRecord({
                  correct: Array.from(context.word),
                });
              },
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
              ({ context }) => {
                scoreService.gradeAndRecord({
                  correct: Array.from(context.word),
                });
              },
            ]
          },
          // The student only made an insertion error on a subsequent try, no score change.
          {
            guard: and([
              { type: 'checkAnswer', params: { fn: detectInsertion } },
              ({ context }) => context.wordErrors === 0
            ]),
            target: 'word',
            actions: [
              ({ context }) => {
                scoreService.gradeAndRecord({
                  correct: Array.from(context.word),
                });
              },
            ]
          },
          // Only make the student go through the letter loop once. 
          {
            guard: ({ context }) => context.wordErrors >= 1,
            target: 'word'
          },

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
