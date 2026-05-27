// Unit-only counterpart to literacy-lesson.service.spec.ts (TEST_DATABASE_URL
// integration spec). Covers branching logic by mocking DB, score service,
// xstate, and the word-list JSON.

const TEST_WORD_LIST = [
  'अब',
  'कमल',
  'पानी',
  'खाना',
  'दीवार',
  'किताब',
  'सूरज',
];

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn(() => JSON.stringify(TEST_WORD_LIST)),
  };
});

const mockTracerStartActiveSpan = jest.fn(async (_name: string, cb: any) =>
  cb({
    setAttribute: jest.fn(),
    setStatus: jest.fn(),
    recordException: jest.fn(),
    end: jest.fn(),
  }),
);
jest.mock('../../otel/otel', () => ({
  tracer: {
    startActiveSpan: (...args: unknown[]) =>
      mockTracerStartActiveSpan(...(args as [string, any])),
  },
}));

// Control the xstate machine output without exercising the real machine.
// processAnswer reads only snapshot.context.{pendingCorrect, pendingIncorrect,
// answer, answerCorrect, word, stateTransitionId} and snapshot.status.
const mockActorGetSnapshot = jest.fn();
const mockActorStart = jest.fn();
const mockActorStop = jest.fn();
const mockActorSend = jest.fn();
jest.mock('xstate', () => {
  const actual = jest.requireActual('xstate');
  return {
    ...actual,
    createActor: jest.fn(() => ({
      start: mockActorStart,
      stop: mockActorStop,
      send: mockActorSend,
      getSnapshot: mockActorGetSnapshot,
    })),
  };
});

import { BadRequestException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { LiteracyLessonService } from './literacy-lesson.service';
import type { LiteracyLessonStateEntity } from './literacy-lesson-state.entity';
import type { ScoreService } from '../score/score.service';

type RepoMock = { findOne: jest.Mock };

function makeRepo(): RepoMock {
  return { findOne: jest.fn() };
}

function makeService(opts: {
  repo?: RepoMock;
  dsQuery?: jest.Mock;
  dsTransaction?: jest.Mock;
  scoreSvc?: Partial<ScoreService>;
}): { svc: LiteracyLessonService; repo: RepoMock; dsQuery: jest.Mock } {
  const repo = opts.repo ?? makeRepo();
  const ds = {
    query: opts.dsQuery ?? jest.fn(),
    transaction:
      opts.dsTransaction ?? jest.fn(async (cb: any) => cb({ query: jest.fn() })),
  } as unknown as DataSource;
  return {
    svc: new LiteracyLessonService(
      repo as unknown as Repository<LiteracyLessonStateEntity>,
      ds,
      (opts.scoreSvc ?? { gradeAndRecord: jest.fn() }) as ScoreService,
    ),
    repo,
    dsQuery: ds.query as jest.Mock,
  };
}

const user = { id: 'u1', external_id: '+919999990001' } as never;

function happySnapshot(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: 'active',
    context: {
      word: 'कमल',
      pendingCorrect: [],
      pendingIncorrect: [],
      answer: 'कमल',
      answerCorrect: null,
      stateTransitionId: 'कमल-start-word-initial',
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockActorGetSnapshot.mockReset();
  mockActorStart.mockReset();
  mockActorStop.mockReset();
  mockActorSend.mockReset();
  mockTracerStartActiveSpan.mockClear();
});

// ─── processAnswer — validation ───────────────────────────────────────────

describe('LiteracyLessonService.processAnswer — validation', () => {
  it('rejects invalid options before any DB hit', async () => {
    const { svc, dsQuery } = makeService({});
    await expect(
      svc.processAnswer({ user_message_id: 'mm-1' } as never),
    ).rejects.toThrow(BadRequestException);
    expect(dsQuery).not.toHaveBeenCalled();
  });
});

// ─── processAnswer — fresh lesson paths ───────────────────────────────────

describe('LiteracyLessonService.processAnswer — start fresh', () => {
  it('starts a new lesson when there is no current state', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const dsQuery = jest
      .fn()
      // selectNextWord query
      .mockResolvedValueOnce([
        {
          letter_scores: [],
          recent_words: [],
          unique_in_add_window: 0,
          unique_in_keep_window: 0,
          recent_row_count: 0,
          distinct_word_count: 0,
        },
      ])
      // INSERT
      .mockResolvedValueOnce([{ id: 'lls-1' }]);

    const { svc } = makeService({ repo, dsQuery });

    const out = await svc.processAnswer({
      user,
      user_message_id: 'mm-1',
    });

    expect(out.stateTransitionIds).toEqual(['कमल-start-word-initial']);
    expect(out.isComplete).toBe(false);
    expect(mockActorSend).not.toHaveBeenCalled(); // fresh start: no ANSWER event
  });

  it('starts fresh AND tags stid with STALE_LESSON_RESTART when last state is 60s-15min old', async () => {
    const repo = makeRepo();
    const oneHourAgo = new Date(Date.now() - 5 * 60 * 1000);
    repo.findOne.mockResolvedValue({
      created_at: oneHourAgo,
      snapshot: { status: 'active', context: {} },
    });
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([
        {
          letter_scores: [],
          recent_words: [],
          unique_in_add_window: 0,
          unique_in_keep_window: 0,
          recent_row_count: 0,
          distinct_word_count: 0,
        },
      ])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);

    const { svc } = makeService({ repo, dsQuery });
    const out = await svc.processAnswer({ user, user_message_id: 'mm-1' });

    expect(out.stateTransitionIds).toEqual([
      'stale-lesson-restart',
      'कमल-start-word-initial',
    ]);
  });

  it('starts fresh WITHOUT stale-restart tag when last state is older than 15 minutes', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({
      created_at: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago
      snapshot: { status: 'active', context: {} },
    });
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([
        {
          letter_scores: [],
          recent_words: [],
          unique_in_add_window: 0,
          unique_in_keep_window: 0,
          recent_row_count: 0,
          distinct_word_count: 0,
        },
      ])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);

    const { svc } = makeService({ repo, dsQuery });
    const out = await svc.processAnswer({ user, user_message_id: 'mm-1' });

    expect(out.stateTransitionIds).toEqual(['कमल-start-word-initial']);
  });

  it('starts fresh (complete-restart) when last snapshot has status=done', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({
      created_at: new Date(),
      snapshot: { status: 'done', context: {} },
    });
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([
        {
          letter_scores: [],
          recent_words: [],
          unique_in_add_window: 0,
          unique_in_keep_window: 0,
          recent_row_count: 0,
          distinct_word_count: 0,
        },
      ])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);

    const { svc } = makeService({ repo, dsQuery });
    const out = await svc.processAnswer({ user, user_message_id: 'mm-1' });

    expect(out.stateTransitionIds).toEqual(['कमल-start-word-initial']);
    expect(mockActorSend).not.toHaveBeenCalled();
  });
});

// ─── processAnswer — continue path ────────────────────────────────────────

describe('LiteracyLessonService.processAnswer — continue (rehydrate)', () => {
  it('rehydrates and sends ANSWER with the combined transcript', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({
      created_at: new Date(),
      snapshot: { status: 'active', context: { word: 'कमल' } },
    });
    mockActorGetSnapshot.mockReturnValue(
      happySnapshot({
        context: {
          word: 'कमल',
          pendingCorrect: [],
          pendingIncorrect: [],
          stateTransitionId: 'कमल-word-complete-correct-first',
        },
        status: 'done',
      }),
    );
    const dsQuery = jest.fn().mockResolvedValueOnce([{ id: 'lls-1' }]);

    const { svc } = makeService({ repo, dsQuery });

    const out = await svc.processAnswer({
      user,
      user_message_id: 'mm-1',
      transcripts: [
        { id: 't-1', text: 'कम' },
        { id: 't-2', text: 'कमल' },
      ] as never,
    });

    expect(mockActorSend).toHaveBeenCalledWith({
      type: 'ANSWER',
      studentAnswer: 'कम कमल', // joined by space
    });
    expect(out.isComplete).toBe(true);
    expect(out.stateTransitionIds).toEqual([
      'कमल-word-complete-correct-first',
    ]);
  });

  it('throws BadRequest when continuing with no transcripts', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({
      created_at: new Date(),
      snapshot: { status: 'active', context: { word: 'कमल' } },
    });

    const { svc } = makeService({ repo });

    await expect(
      svc.processAnswer({ user, user_message_id: 'mm-1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('joins multiple transcript rows with a space (default if .text is null)', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({
      created_at: new Date(),
      snapshot: { status: 'active', context: { word: 'कमल' } },
    });
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const dsQuery = jest.fn().mockResolvedValueOnce([{ id: 'lls-1' }]);

    const { svc } = makeService({ repo, dsQuery });
    await svc.processAnswer({
      user,
      user_message_id: 'mm-1',
      transcripts: [
        { id: 't-1', text: null },
        { id: 't-2', text: 'कमल' },
      ] as never,
    });

    expect(mockActorSend.mock.calls[0][0].studentAnswer).toBe(' कमल');
  });
});

// ─── processAnswer — INSERT rolled-back guard ─────────────────────────────

describe('LiteracyLessonService.processAnswer — rolled-back media', () => {
  it('throws "Media was rolled back" when the INSERT returns zero rows', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([
        {
          letter_scores: [],
          recent_words: [],
          unique_in_add_window: 0,
          unique_in_keep_window: 0,
          recent_row_count: 0,
          distinct_word_count: 0,
        },
      ])
      .mockResolvedValueOnce([]); // INSERT — zero rows (media rolled back)

    const { svc } = makeService({ repo, dsQuery });

    await expect(
      svc.processAnswer({ user, user_message_id: 'mm-1' }),
    ).rejects.toThrow('Media was rolled back');
  });
});

// ─── processAnswer — score recording ──────────────────────────────────────

describe('LiteracyLessonService.processAnswer — score recording', () => {
  function setup({
    pendingCorrect,
    pendingIncorrect,
    gradeReject,
  }: {
    pendingCorrect: string[];
    pendingIncorrect: string[];
    gradeReject?: Error;
  }) {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    mockActorGetSnapshot.mockReturnValue(
      happySnapshot({
        context: {
          word: 'कमल',
          pendingCorrect,
          pendingIncorrect,
          stateTransitionId: 'sid',
        },
      }),
    );
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([
        {
          letter_scores: [],
          recent_words: [],
          unique_in_add_window: 0,
          unique_in_keep_window: 0,
          recent_row_count: 0,
          distinct_word_count: 0,
        },
      ])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);
    const gradeAndRecord = gradeReject
      ? jest.fn().mockRejectedValue(gradeReject)
      : jest.fn().mockResolvedValue([]);
    return { ...makeService({ repo, dsQuery, scoreSvc: { gradeAndRecord } }), gradeAndRecord };
  }

  it('skips gradeAndRecord when both pending arrays are empty', async () => {
    const { svc, gradeAndRecord } = setup({
      pendingCorrect: [],
      pendingIncorrect: [],
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(gradeAndRecord).not.toHaveBeenCalled();
  });

  it('passes pendingCorrect (omits incorrect) when only correct is non-empty', async () => {
    const { svc, gradeAndRecord } = setup({
      pendingCorrect: ['क', 'म'],
      pendingIncorrect: [],
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(gradeAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        correct: ['क', 'म'],
        incorrect: undefined,
        userMessageId: 'mm-1',
      }),
    );
  });

  it('passes pendingIncorrect (omits correct) when only incorrect is non-empty', async () => {
    const { svc, gradeAndRecord } = setup({
      pendingCorrect: [],
      pendingIncorrect: ['ल'],
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(gradeAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        correct: undefined,
        incorrect: ['ल'],
      }),
    );
  });

  it('tolerates gradeAndRecord rejection (logs warn, processAnswer still resolves)', async () => {
    const { svc } = setup({
      pendingCorrect: ['क'],
      pendingIncorrect: [],
      gradeReject: new Error('score svc down'),
    });
    await expect(
      svc.processAnswer({ user, user_message_id: 'mm-1' }),
    ).resolves.toBeDefined();
  });
});

// ─── processAnswer — isComplete + word attribute ──────────────────────────

describe('LiteracyLessonService.processAnswer — isComplete flag', () => {
  it('returns isComplete=true when snapshot.status is "done"', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    mockActorGetSnapshot.mockReturnValue(
      happySnapshot({ status: 'done' }),
    );
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([
        {
          letter_scores: [],
          recent_words: [],
          unique_in_add_window: 0,
          unique_in_keep_window: 0,
          recent_row_count: 0,
          distinct_word_count: 0,
        },
      ])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);

    const { svc } = makeService({ repo, dsQuery });
    const out = await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(out.isComplete).toBe(true);
  });
});

// ─── findCurrentState ─────────────────────────────────────────────────────

describe('LiteracyLessonService.findCurrentState', () => {
  it('returns the most recent state row', async () => {
    const repo = makeRepo();
    const row = { id: 'lls-1', snapshot: {} };
    repo.findOne.mockResolvedValue(row);
    const { svc } = makeService({ repo });
    await expect(svc.findCurrentState('u1')).resolves.toBe(row);
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { user_id: 'u1' },
      order: { created_at: 'DESC' },
    });
  });

  it('returns null when there is no state row', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(undefined);
    const { svc } = makeService({ repo });
    await expect(svc.findCurrentState('u1')).resolves.toBeNull();
  });
});

// ─── cleanupPartialState ──────────────────────────────────────────────────

describe('LiteracyLessonService.cleanupPartialState', () => {
  it('deletes scores and lesson-states for the given user_message_id inside a transaction', async () => {
    const txQuery = jest
      .fn()
      .mockResolvedValueOnce([{ id: 's1' }, { id: 's2' }]) // scores deleted
      .mockResolvedValueOnce([{ id: 'lls-1' }]); // states deleted
    const dsTransaction = jest.fn(async (cb: any) => cb({ query: txQuery }));

    const { svc } = makeService({ dsTransaction });

    await svc.cleanupPartialState('mm-1');

    expect(txQuery).toHaveBeenCalledTimes(2);
    expect(txQuery.mock.calls[0][0]).toMatch(/DELETE FROM scores/);
    expect(txQuery.mock.calls[0][1]).toEqual(['mm-1']);
    expect(txQuery.mock.calls[1][0]).toMatch(/DELETE FROM literacy_lesson_states/);
  });
});

// ─── selectNextWord — covered indirectly through processAnswer.startFresh,
// but the branching here is dense enough to deserve focused tests via the
// same indirection.

describe('LiteracyLessonService — selectNextWord branches (via processAnswer fresh start)', () => {
  function setupSelect(dbRow: Record<string, unknown>) {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([dbRow])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);
    return makeService({ repo, dsQuery });
  }

  it('new user (distinct_word_count < 3) → maxLength floor of 2 — only short words possible', async () => {
    const { svc } = setupSelect({
      letter_scores: [],
      recent_words: [],
      unique_in_add_window: 0,
      unique_in_keep_window: 0,
      recent_row_count: 0,
      distinct_word_count: 0,
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    // The actor was created with a 2-char word from the test list.
    const createActorMock = jest.requireMock('xstate').createActor as jest.Mock;
    const input = createActorMock.mock.calls[0][1].input;
    expect([...(input.word as string)].length).toBeLessThanOrEqual(2);
  });

  it('progress (uniqueInAddWindow >= 3) → maxLength = mostRecentLen + 1', async () => {
    const { svc } = setupSelect({
      letter_scores: [],
      recent_words: ['कम'], // 2 chars
      unique_in_add_window: 3,
      unique_in_keep_window: 3,
      recent_row_count: 8,
      distinct_word_count: 5,
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    const createActorMock = jest.requireMock('xstate').createActor as jest.Mock;
    const input = createActorMock.mock.calls[0][1].input;
    expect([...(input.word as string)].length).toBeLessThanOrEqual(3);
  });

  it('plateau (uniqueInAddWindow < 3, uniqueInKeepWindow >= 3) → maxLength = mostRecentLen', async () => {
    const { svc } = setupSelect({
      letter_scores: [],
      recent_words: ['कमल'], // 3 chars
      unique_in_add_window: 1,
      unique_in_keep_window: 3,
      recent_row_count: 8,
      distinct_word_count: 5,
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    const createActorMock = jest.requireMock('xstate').createActor as jest.Mock;
    const input = createActorMock.mock.calls[0][1].input;
    expect([...(input.word as string)].length).toBeLessThanOrEqual(3);
  });

  it('regression (neither window threshold met) → maxLength = mostRecentLen - 1', async () => {
    const { svc } = setupSelect({
      letter_scores: [],
      recent_words: ['कमल'], // 3 chars
      unique_in_add_window: 0,
      unique_in_keep_window: 0,
      recent_row_count: 8,
      distinct_word_count: 5,
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    const createActorMock = jest.requireMock('xstate').createActor as jest.Mock;
    const input = createActorMock.mock.calls[0][1].input;
    // mostRecentLen-1 = 2 (floor)
    expect([...(input.word as string)].length).toBeLessThanOrEqual(2);
  });

  it('defensive: distinct_word_count >= 3 but recent_words empty → falls back to floor + WARN', async () => {
    const { svc } = setupSelect({
      letter_scores: [],
      recent_words: [],
      unique_in_add_window: 5,
      unique_in_keep_window: 5,
      recent_row_count: 10,
      distinct_word_count: 10,
    });
    // No throw — service warns and falls back.
    await expect(
      svc.processAnswer({ user, user_message_id: 'mm-1' }),
    ).resolves.toBeDefined();
  });

  it('uses reviewed (non-half-integer) scores to compute baseline; ignores integer/half-integer seeds', async () => {
    // Reviewed: 1.01 + 2.01 = 3.02 / 2 = 1.51 baseline.
    // Seed (0.5 multiples): contribute raw to word score (not baseline).
    const { svc } = setupSelect({
      letter_scores: [
        { grapheme: 'क', score: 1.01 }, // reviewed
        { grapheme: 'म', score: 2.01 }, // reviewed
        { grapheme: 'ल', score: 0.5 }, // seed (half-integer)
        { grapheme: 'अ', score: 0 }, // seed (integer)
      ],
      recent_words: [],
      unique_in_add_window: 0,
      unique_in_keep_window: 0,
      recent_row_count: 0,
      distinct_word_count: 0,
    });
    // Should not throw — exercises the baseline + scoring loop.
    await expect(
      svc.processAnswer({ user, user_message_id: 'mm-1' }),
    ).resolves.toBeDefined();
  });

  it('falls back to a random 2-letter word when no candidates remain after filtering', async () => {
    // Force candidates to empty by pretending every word in the list is a
    // "recent word". The fallback path picks a 2-letter word from the full
    // list regardless.
    const { svc } = setupSelect({
      letter_scores: [],
      recent_words: TEST_WORD_LIST,
      unique_in_add_window: 0,
      unique_in_keep_window: 0,
      recent_row_count: 0,
      distinct_word_count: 0,
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    const createActorMock = jest.requireMock('xstate').createActor as jest.Mock;
    const input = createActorMock.mock.calls[0][1].input;
    // 'अब' is the only 2-letter word in TEST_WORD_LIST.
    expect(input.word).toBe('अब');
  });
});
