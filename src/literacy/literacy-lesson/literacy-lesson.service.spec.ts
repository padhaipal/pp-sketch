// Unit tests for LiteracyLessonService. DB, score service, xstate, and the
// word-list JSON are mocked so no Postgres / file I/O is needed.

// uuid is ESM-only — transitively imported via UserService.
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'gen-uuid'),
  validate: (s: unknown): boolean =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));

const TEST_WORD_LIST = ['अब', 'कमल', 'पानी', 'खाना', 'दीवार', 'किताब', 'सूरज'];

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn(() => JSON.stringify(TEST_WORD_LIST)),
  };
});

// Hoisted so tests can assert span attributes (pp.lesson.path / pp.lesson.word
// etc.). Both processAnswer's and selectNextWord's spans share this mock.
const mockSpanSetAttribute = jest.fn();
const mockTracerStartActiveSpan = jest.fn(async (_name: string, cb: any) =>
  cb({
    setAttribute: mockSpanSetAttribute,
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

import { BadRequestException, Logger } from '@nestjs/common';
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
      opts.dsTransaction ??
      jest.fn(async (cb: any) => cb({ query: jest.fn() })),
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
  mockSpanSetAttribute.mockClear();
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
      // Engines are joined with ' ~ ' so their seam can never form an answer;
      // the per-engine texts travel separately for sentence evaluation.
      studentAnswer: 'कम ~ कमल',
      studentTranscripts: ['कम', 'कमल'],
    });
    expect(out.isComplete).toBe(true);
    expect(out.stateTransitionIds).toEqual(['कमल-word-complete-correct-first']);
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

  it('joins multiple transcript rows with the tilde separator (default if .text is null)', async () => {
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

    expect(mockActorSend.mock.calls[0][0].studentAnswer).toBe(' ~ कमल');
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
    return {
      ...makeService({ repo, dsQuery, scoreSvc: { gradeAndRecord } }),
      gradeAndRecord,
    };
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
    mockActorGetSnapshot.mockReturnValue(happySnapshot({ status: 'done' }));
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
    expect(txQuery.mock.calls[1][0]).toMatch(
      /DELETE FROM literacy_lesson_states/,
    );
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

  it('baseline = mean of reviewed (non-half-integer) scores only; ignores seeds', async () => {
    // 1.25 and 2.75 are NOT multiples of 0.5 → "reviewed"; 0.5 and 1 are seeds.
    // baseline = (1.25 + 2.75) / 2 = 2.0 exactly (chosen for binary-exactness).
    // Asserting the exact span value kills: the reviewed-detection mutants
    // (! removed / always-true / always-false / score/2), the
    // reviewedScores.length===0 ternary mutants, the reduce sum+v → sum-v,
    // and the mean's / → *.
    const { svc } = setupSelect({
      letter_scores: [
        { grapheme: 'क', score: 1.25 }, // reviewed
        { grapheme: 'म', score: 2.75 }, // reviewed
        { grapheme: 'ल', score: 0.5 }, // seed (half-integer)
        { grapheme: 'अ', score: 1 }, // seed (integer)
      ],
      recent_words: [],
      unique_in_add_window: 0,
      unique_in_keep_window: 0,
      recent_row_count: 0,
      distinct_word_count: 0,
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.word.baseline',
      2,
    ]);
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.word.reviewed_count',
      2,
    ]);
  });

  it('reviewed-empty → baseline 0 (kills the length===0 ternary false branch)', async () => {
    // Only seed scores (integer / half-integer) → reviewedScores empty → 0.
    const { svc } = setupSelect({
      letter_scores: [
        { grapheme: 'क', score: 1 }, // seed
        { grapheme: 'म', score: 0.5 }, // seed
      ],
      recent_words: [],
      unique_in_add_window: 0,
      unique_in_keep_window: 0,
      recent_row_count: 0,
      distinct_word_count: 0,
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.word.baseline',
      0,
    ]);
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.word.reviewed_count',
      0,
    ]);
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

// ─── mutation hardening ──────────────────────────────────────────────────────

const xstateMock = jest.requireMock('xstate');

// Drive a fresh-lesson selection and return the word createActor was seeded
// with. `row` is the single row returned by the selectNextWord query.
async function selectedWord(row: Record<string, unknown>): Promise<string> {
  xstateMock.createActor.mockClear();
  const dsQuery = jest
    .fn()
    .mockResolvedValueOnce([row]) // selectNextWord
    .mockResolvedValueOnce([{ id: 'lls-1' }]); // INSERT
  mockActorGetSnapshot.mockReturnValue(happySnapshot());
  const repo = makeRepo();
  repo.findOne.mockResolvedValue(null); // no current state → start fresh
  const { svc } = makeService({ repo, dsQuery });
  await svc.processAnswer({ user, user_message_id: 'mm-1' });
  return xstateMock.createActor.mock.calls[0][1].input.word as string;
}

function freshRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    letter_scores: [],
    recent_words: [],
    unique_in_add_window: 0,
    unique_in_keep_window: 0,
    recent_row_count: 0,
    distinct_word_count: 0,
    ...over,
  };
}
const seed = (graphemes: string[], score: number) =>
  graphemes.map((grapheme) => ({ grapheme, score })); // integer*2 → "seed"

describe('LiteracyLessonService.processAnswer — lesson-path age boundaries', () => {
  function stateAt(ageMs: number, status = 'active') {
    const T = 1_900_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({
      created_at: new Date(T - ageMs),
      snapshot: { status, context: { word: 'कमल' } },
    });
    return { nowSpy, repo };
  }

  it('age exactly 900_000 ms → stale-restart, NOT fresh (kills >900000 → >=900000)', async () => {
    const { nowSpy, repo } = stateAt(900_000);
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([freshRow({ distinct_word_count: 0 })]) // selectNextWord (startFresh)
      .mockResolvedValueOnce([{ id: 'lls-1' }]);
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const { svc } = makeService({ repo, dsQuery });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.path',
      'stale-restart',
    ]);
    nowSpy.mockRestore();
  });

  it('age 900_001 ms → fresh', async () => {
    const { nowSpy, repo } = stateAt(900_001);
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([freshRow()])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const { svc } = makeService({ repo, dsQuery });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.path',
      'fresh',
    ]);
    nowSpy.mockRestore();
  });

  it('age exactly 120_000 ms → continue (rehydrate), NOT stale-restart (kills >120000 → >=120000)', async () => {
    const { nowSpy, repo } = stateAt(120_000);
    const dsQuery = jest.fn().mockResolvedValueOnce([{ id: 'lls-1' }]); // only the INSERT (continue path)
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const { svc } = makeService({ repo, dsQuery });
    await svc.processAnswer({
      user,
      user_message_id: 'mm-1',
      transcripts: [{ id: 't1', text: 'कमल' }] as never,
    });
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.path',
      'continue',
    ]);
    expect(mockActorSend).toHaveBeenCalled(); // rehydrate path sends ANSWER
    nowSpy.mockRestore();
  });

  it('age 120_001 ms → stale-restart', async () => {
    const { nowSpy, repo } = stateAt(120_001);
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([freshRow()])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const { svc } = makeService({ repo, dsQuery });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.path',
      'stale-restart',
    ]);
    nowSpy.mockRestore();
  });

  it('age 30s + snapshot done → complete-restart', async () => {
    const { nowSpy, repo } = stateAt(30_000, 'done');
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([freshRow()])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const { svc } = makeService({ repo, dsQuery });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.path',
      'complete-restart',
    ]);
    nowSpy.mockRestore();
  });
});

describe('LiteracyLessonService.processAnswer — persisted snapshot fields', () => {
  it('persists snapshot.context.answer + answerCorrect verbatim (kills ?? → &&)', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    mockActorGetSnapshot.mockReturnValue(
      happySnapshot({
        context: {
          word: 'कमल',
          pendingCorrect: [],
          pendingIncorrect: [],
          answer: 'क',
          answerCorrect: true,
          stateTransitionId: 'sid',
        },
      }),
    );
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([freshRow()])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);
    const { svc } = makeService({ repo, dsQuery });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    const insertParams = dsQuery.mock.calls[1][1];
    // params: [user.id, user_message_id, word, answer, answerCorrect, snapshotJson]
    expect(insertParams[3]).toBe('क'); // answer ?? null → 'क' (mutant && → null)
    expect(insertParams[4]).toBe(true); // answerCorrect ?? null → true (mutant && → null)
  });

  it('tags pp.lesson.word when the snapshot word is a string', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([freshRow()])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);
    const { svc } = makeService({ repo, dsQuery });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.word',
      'कमल',
    ]);
  });
});

describe('LiteracyLessonService.selectNextWord — exact length thresholds', () => {
  // TEST_WORD_LIST grapheme lengths: अब=2, कमल=3, पानी/खाना/सूरज=4, दीवार/किताब=5.

  it('new user (distinct_word_count < 3) floors maxLength to 2 → only अब qualifies', async () => {
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 2,
        recent_row_count: 20,
        recent_words: ['कमल'],
        unique_in_add_window: 5,
        letter_scores: seed(['स', 'ू', 'र', 'ज'], -5), // सूरज would win if it qualified
      }),
    );
    expect(word).toBe('अब');
  });

  it('distinct_word_count exactly 3 does NOT floor (kills < → <=) → a length-4 word can win', async () => {
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 3,
        recent_row_count: 20,
        recent_words: ['कमल'], // mostRecentLen 3, +1 progression → maxLength 4
        unique_in_add_window: 5,
        letter_scores: seed(['स', 'ू', 'र', 'ज'], -5),
      }),
    );
    expect(word).toBe('सूरज');
  });

  it('recent_row_count exactly 8 does NOT floor (kills < → <=) → length-4 word can win', async () => {
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 8,
        recent_words: ['कमल'],
        unique_in_add_window: 5,
        letter_scores: seed(['स', 'ू', 'र', 'ज'], -5),
      }),
    );
    expect(word).toBe('सूरज');
  });

  it('progression: uniqueInAddWindow >= 3 → maxLength = mostRecentLen + 1 (kills +1 → -1)', async () => {
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 20,
        recent_words: ['कमल'], // len 3 → +1 → 4
        unique_in_add_window: 3,
        unique_in_keep_window: 3,
        letter_scores: seed(['स', 'ू', 'र', 'ज'], -5), // 4-letter target
      }),
    );
    expect(word).toBe('सूरज');
  });

  it('plateau: uniqueInAddWindow < 3 but uniqueInKeepWindow >= 3 → maxLength = mostRecentLen', async () => {
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 20,
        recent_words: ['पानी'], // len 4 → plateau → maxLength 4
        unique_in_add_window: 2,
        unique_in_keep_window: 3,
        letter_scores: seed(['स', 'ू', 'र', 'ज'], -5),
      }),
    );
    expect(word).toBe('सूरज');
  });

  it('regression: neither window threshold met → maxLength = mostRecentLen - 1', async () => {
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 20,
        recent_words: ['पानी'], // len 4 → -1 → maxLength 3
        unique_in_add_window: 0,
        unique_in_keep_window: 0,
        letter_scores: seed(['क', 'म', 'ल'], -5), // 3-letter target
      }),
    );
    expect(word).toBe('कमल');
  });

  // NB: the `<= maxLength` boundary (kills `<= → <`) is exercised by the
  // progression test above — under `< maxLength` the exactly-maxLength target
  // (सूरज at len 4) is filtered out and selection falls to a shorter word.
});

describe('LiteracyLessonService.selectNextWord — scoring + exclusion + tie-break', () => {
  it('excludes recently-seen words even when they have the minimum score (kills !has → has)', async () => {
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 20,
        recent_words: ['कमल'], // कमल recent → excluded; mostRecentLen 3, +1 → maxLength 4
        unique_in_add_window: 5,
        // कमल would be the min (−15) but it's excluded; सूरज is the next target.
        letter_scores: [
          ...seed(['क', 'म', 'ल'], -15),
          ...seed(['स', 'ू', 'र', 'ज'], -5),
        ],
      }),
    );
    expect(word).toBe('सूरज');
    expect(word).not.toBe('कमल');
  });

  it('reviewed letters are scored relative to the baseline (kills the +(score-baseline) sign + baseline /→*)', async () => {
    // Reviewed (non-half-integer) scores set baseline = mean(-10.01, 2.01) = -4.
    // Plateau on खाना (len 4) → maxLength 4, so the len-5 किताब (which also
    // contains क) is filtered out, leaving कमल as the sole bearer of क.
    //   कमल = क(-10.01 - -4 = -6.01) → unique min; पानी = प(2.01 - -4 = 6.01).
    // Sign mutant: क becomes +6.01 → पानी (-6.01) wins instead.
    // baseline /→*: baseline = -16 → कमल = +5.99, all non-क/प words score 0 →
    //   the longest 0-word (सूरज) wins instead.
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 20,
        recent_words: ['खाना'], // len 4 → plateau → maxLength 4 (len-5 words excluded)
        unique_in_add_window: 2,
        unique_in_keep_window: 3,
        letter_scores: [
          { grapheme: 'क', score: -10.01 },
          { grapheme: 'प', score: 2.01 },
        ],
      }),
    );
    expect(word).toBe('कमल');
  });

  it('seed (half-integer) scores are added raw, not baseline-adjusted', async () => {
    // Only seed scores → no reviewed → baseline 0 → कमल = -3 (min).
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 20,
        recent_words: ['खाना'],
        unique_in_add_window: 5,
        letter_scores: seed(['क', 'म', 'ल'], -1),
      }),
    );
    expect(word).toBe('कमल');
  });

  it('falls back to a random two-letter word when every candidate is recently seen', async () => {
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 20,
        recent_words: [...TEST_WORD_LIST], // everything excluded → empty candidates
        unique_in_add_window: 5,
      }),
    );
    expect(word).toBe('अब'); // the only 2-letter word in the list
  });

  it('tie-break picks among the longest words via Math.random index (kills * → /)', async () => {
    // No letter scores → every candidate scores 0 → all tie → longest (5-letter:
    // दीवार, किताब) → random. Math.random=0.6, len 2 → floor(0.6*2)=1 → किताब.
    // The `* → /` mutant gives floor(0.6/2)=0 → दीवार.
    const rndSpy = jest.spyOn(Math, 'random').mockReturnValue(0.6);
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 20,
        recent_words: ['दीवार'], // mostRecentLen 5, +1 → maxLength 6 (all qualify)
        unique_in_add_window: 5,
      }),
    );
    // दीवार is recent → excluded; remaining longest is किताब (only 5-letter left).
    expect(word).toBe('किताब');
    rndSpy.mockRestore();
  });
});

// ─── mutation hardening 2: telemetry, logs, SQL, scoring sign ─────────────────

// Build a fresh-start service whose selectNextWord returns `row`, with a fully
// controlled snapshot. Returns the service + the INSERT param capture.
function freshStart(row: Record<string, unknown>, snapshot = happySnapshot()) {
  const repo = makeRepo();
  repo.findOne.mockResolvedValue(null);
  mockActorGetSnapshot.mockReturnValue(snapshot);
  const dsQuery = jest
    .fn()
    .mockResolvedValueOnce([row])
    .mockResolvedValueOnce([{ id: 'lls-1' }]);
  return { ...makeService({ repo, dsQuery }), dsQuery };
}

describe('LiteracyLessonService — span telemetry', () => {
  it('emits every selectNextWord + processAnswer span attribute with exact keys/values', async () => {
    // Deterministic scored set (maxLength 4 via progression on the len-3 कमल):
    //   candidates after excluding कमल: अब, पानी, खाना, सूरज.
    //   सूरज = स+ू+र+ज seeds (-2 each) = -8 (unique min → selected);
    //   पानी = प seed (-1) = -1; अब/खाना have no scored letters = 0.
    const { svc } = freshStart({
      letter_scores: [
        { grapheme: 'स', score: -2 },
        { grapheme: 'ू', score: -2 },
        { grapheme: 'र', score: -2 },
        { grapheme: 'ज', score: -2 },
        { grapheme: 'प', score: -1 },
      ],
      recent_words: ['कमल'], // len 3, progression +1 → maxLength 4
      unique_in_add_window: 3,
      unique_in_keep_window: 5,
      recent_row_count: 20,
      distinct_word_count: 20,
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    const calls = mockSpanSetAttribute.mock.calls;

    // processAnswer span
    expect(calls).toContainEqual(['pp.lesson.user_message_id', 'mm-1']);
    expect(calls).toContainEqual(['pp.lesson.path', 'fresh']);
    expect(calls).toContainEqual([
      'pp.lesson.state_transition_id',
      'कमल-start-word-initial',
    ]);
    expect(calls).toContainEqual(['pp.lesson.is_complete', false]);
    expect(calls).toContainEqual(['pp.lesson.word', 'कमल']); // from snapshot

    // selectNextWord span
    expect(calls).toContainEqual(['pp.lesson.word.max_length', 4]);
    expect(calls).toContainEqual(['pp.lesson.word.baseline', 0]);
    expect(calls).toContainEqual(['pp.lesson.word.reviewed_count', 0]);
    expect(calls).toContainEqual([
      'pp.lesson.word.selection',
      'min-score-longest-tie-break',
    ]);
    expect(calls).toContainEqual(['pp.lesson.word.selected', 'सूरज']);
    expect(calls).toContainEqual(['pp.lesson.word.unique_in_add_window', 3]);
    expect(calls).toContainEqual(['pp.lesson.word.unique_in_keep_window', 5]);
    // top_5 is sorted ascending by score then formatted — pins the sort
    // comparator, the slice/map/join chain, and the toFixed(3) formatting.
    expect(calls).toContainEqual([
      'pp.lesson.word.top_5',
      'सूरज=-8.000, पानी=-1.000, अब=0.000, खाना=0.000',
    ]);

    // pp.user.id is set once per span (processAnswer + selectNextWord).
    expect(calls.filter((c) => c[0] === 'pp.user.id')).toEqual([
      ['pp.user.id', 'u1'],
      ['pp.user.id', 'u1'],
    ]);
  });

  it('names both active spans (kills the startActiveSpan name literals)', async () => {
    const { svc } = freshStart(freshRow());
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    const names = mockTracerStartActiveSpan.mock.calls.map((c) => c[0]);
    expect(names).toContain('literacy.processAnswer');
    expect(names).toContain('literacy.selectNextString');
  });

  it('does NOT tag pp.lesson.word when the snapshot word is not a string', async () => {
    const { svc } = freshStart(
      freshRow(),
      happySnapshot({
        context: {
          word: 123, // non-string
          pendingCorrect: [],
          pendingIncorrect: [],
          stateTransitionId: 'sid',
        },
      }),
    );
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    const wordTags = mockSpanSetAttribute.mock.calls.filter(
      (c) => c[0] === 'pp.lesson.word',
    );
    expect(wordTags).toHaveLength(0);
  });
});

describe('LiteracyLessonService — log messages', () => {
  it('warns with the rolled-back message when INSERT returns 0 rows', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    mockActorGetSnapshot.mockReturnValue(happySnapshot());
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([freshRow()])
      .mockResolvedValueOnce([]); // INSERT — rolled back
    const { svc } = makeService({ repo, dsQuery });
    await expect(
      svc.processAnswer({ user, user_message_id: 'mm-1' }),
    ).rejects.toThrow('Media was rolled back');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'processAnswer: INSERT returned 0 rows — media mm-1',
      ),
    );
    warnSpy.mockRestore();
  });

  it('warns (and still resolves) when gradeAndRecord rejects', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    mockActorGetSnapshot.mockReturnValue(
      happySnapshot({
        context: {
          word: 'कमल',
          pendingCorrect: ['क'],
          pendingIncorrect: [],
          stateTransitionId: 'sid',
        },
      }),
    );
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([freshRow()])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);
    const gradeAndRecord = jest
      .fn()
      .mockRejectedValue(new Error('score svc down'));
    const { svc } = makeService({
      repo,
      dsQuery,
      scoreSvc: { gradeAndRecord },
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'processAnswer: gradeAndRecord failed: score svc down',
      ),
    );
    warnSpy.mockRestore();
  });

  it('logs the cleanup summary with counts', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const txQuery = jest
      .fn()
      .mockResolvedValueOnce([{ id: 's1' }, { id: 's2' }])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);
    const dsTransaction = jest.fn(async (cb: any) => cb({ query: txQuery }));
    const { svc } = makeService({ dsTransaction });
    await svc.cleanupPartialState('mm-1');
    expect(logSpy).toHaveBeenCalledWith(
      'cleanupPartialState: user_message_id=mm-1 scores_deleted=2 lesson_states_deleted=1',
    );
    logSpy.mockRestore();
  });

  it('warns about unknown graphemes, listing the count', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    // floor maxLength 2 → only अब; अ/ब are unscored → 2 unknown graphemes.
    const { svc } = freshStart(freshRow({ distinct_word_count: 0 }));
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown grapheme(s) for user u1'),
    );
    warnSpy.mockRestore();
  });

  it('does NOT warn about unknown graphemes when every candidate letter is scored', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    // floor maxLength 2 → only अब; provide scores for both अ and ब.
    const { svc } = freshStart(
      freshRow({
        distinct_word_count: 0,
        letter_scores: seed(['अ', 'ब'], 0),
      }),
    );
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    const unknownWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('unknown grapheme'),
    );
    expect(unknownWarns).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('warns when distinct_word_count >= 3 but recent_words is empty', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { svc } = freshStart(
      freshRow({
        distinct_word_count: 10,
        recent_row_count: 10,
        recent_words: [],
        unique_in_add_window: 5,
        unique_in_keep_window: 5,
      }),
    );
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'distinct_word_count=10 but recent_words is empty for user u1',
      ),
    );
    warnSpy.mockRestore();
  });

  it('logs the selection summary on a successful pick', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const { svc } = freshStart(freshRow({ distinct_word_count: 0 }));
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('selectNextString: selected=अब'),
    );
    logSpy.mockRestore();
  });

  it('warns + tags fallback selection when no candidate survives filtering', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { svc } = freshStart(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 20,
        recent_words: [...TEST_WORD_LIST], // everything excluded
        unique_in_add_window: 5,
      }),
    );
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'no candidates after filtering — falling back to random two-letter word',
      ),
    );
    const calls = mockSpanSetAttribute.mock.calls;
    expect(calls).toContainEqual([
      'pp.lesson.word.selection',
      'fallback-random-two-letter',
    ]);
    expect(calls).toContainEqual(['pp.lesson.word.selected', 'अब']);
    warnSpy.mockRestore();
  });
});

describe('LiteracyLessonService — exact SQL statements', () => {
  it('selectNextWord uses the recent_distinct_words CTE query', async () => {
    const { svc, dsQuery } = freshStart(freshRow());
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(dsQuery.mock.calls[0][0]).toContain('WITH recent_distinct_words');
  });

  it('persists via INSERT INTO literacy_lesson_states ... RETURNING', async () => {
    const { svc, dsQuery } = freshStart(freshRow());
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(dsQuery.mock.calls[1][0]).toContain(
      'INSERT INTO literacy_lesson_states',
    );
    expect(dsQuery.mock.calls[1][0]).toContain('RETURNING');
  });
});

describe('LiteracyLessonService — maxLength span value at thresholds', () => {
  it('new user floors maxLength to exactly 2', async () => {
    const { svc } = freshStart(freshRow({ distinct_word_count: 2 }));
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.word.max_length',
      2,
    ]);
  });

  it('defensive (recent_words empty) floors maxLength to exactly 2', async () => {
    const { svc } = freshStart(
      freshRow({
        distinct_word_count: 10,
        recent_row_count: 10,
        recent_words: [],
        unique_in_add_window: 5,
        unique_in_keep_window: 5,
      }),
    );
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.word.max_length',
      2,
    ]);
  });

  it('regression path sets maxLength to mostRecentLen - 1 (kills the else-if → true)', async () => {
    const { svc } = freshStart(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 20,
        recent_words: ['पानी'], // len 4 → regression → maxLength 3
        unique_in_add_window: 0,
        unique_in_keep_window: 0,
      }),
    );
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.word.max_length',
      3,
    ]);
  });
});

describe('LiteracyLessonService — combined transcript guard (L59)', () => {
  it('an empty transcripts array still throws on the continue path (kills >0 → >=0 and cond → true)', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({
      created_at: new Date(),
      snapshot: { status: 'active', context: { word: 'कमल' } },
    });
    const { svc } = makeService({ repo });
    await expect(
      svc.processAnswer({
        user,
        user_message_id: 'mm-1',
        transcripts: [] as never,
      }),
    ).rejects.toThrow(
      'Rehydrating an existing lesson requires a student answer',
    );
  });
});

describe('LiteracyLessonService — pending-score defaults (L139/L141)', () => {
  it('treats missing pendingCorrect/pendingIncorrect as empty → no gradeAndRecord call', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    mockActorGetSnapshot.mockReturnValue({
      status: 'active',
      context: {
        word: 'कमल',
        // pendingCorrect / pendingIncorrect intentionally undefined
        stateTransitionId: 'sid',
      },
    });
    const dsQuery = jest
      .fn()
      .mockResolvedValueOnce([freshRow()])
      .mockResolvedValueOnce([{ id: 'lls-1' }]);
    const gradeAndRecord = jest.fn().mockResolvedValue([]);
    const { svc } = makeService({
      repo,
      dsQuery,
      scoreSvc: { gradeAndRecord },
    });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    expect(gradeAndRecord).not.toHaveBeenCalled();
  });
});

describe('LiteracyLessonService — reviewed-vs-baseline scoring sign (L403/L406)', () => {
  it('reviewed letters subtract the baseline so a below-baseline word wins (kills score-baseline → score+baseline and the seed/reviewed branch → true)', async () => {
    // baseline = mean(2.1, 2.1, 4.1) ≈ 2.767.
    //   कमल = क,म reviewed (2.1 - 2.767 each ≈ -0.667 ×2 = -1.33) → unique min.
    //   पानी = प reviewed (4.1 - 2.767 ≈ 1.33). अब/सूरज = 0.
    // score+baseline mutant: कमल/पानी both >0 → a zero-word wins instead.
    // seed-branch → true (treat all as raw): कमल = 4.2, पानी = 4.1 → zero-word.
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 20,
        recent_words: ['खाना'], // len 4 → plateau → maxLength 4
        unique_in_add_window: 2,
        unique_in_keep_window: 3,
        letter_scores: [
          { grapheme: 'क', score: 2.1 },
          { grapheme: 'म', score: 2.1 },
          { grapheme: 'प', score: 4.1 },
        ],
      }),
    );
    expect(word).toBe('कमल');
  });

  it('seed letters keep their raw score so the seed-branch is taken (kills branch → false / emptied block)', async () => {
    // Reviewed स,र (2.1) set baseline 2.1 (their own contribution → 0).
    // Seed ज (-1, integer) keeps raw → सूरज = -1 (unique min, selected).
    // Seed क/म/ल (+1) keep raw → कमल = +3 (not selected).
    // If seeds were treated as reviewed (score - 2.1): सूरज's ज → -3.1 and
    // कमल → 3×(1-2.1) = -3.3 < -3.1 → कमल would win instead.
    const word = await selectedWord(
      freshRow({
        distinct_word_count: 20,
        recent_row_count: 20,
        recent_words: ['खाना'], // len 4 → plateau → maxLength 4
        unique_in_add_window: 2,
        unique_in_keep_window: 3,
        letter_scores: [
          { grapheme: 'स', score: 2.1 }, // reviewed
          { grapheme: 'र', score: 2.1 }, // reviewed
          { grapheme: 'ज', score: -1 }, // seed
          { grapheme: 'क', score: 1 }, // seed
          { grapheme: 'म', score: 1 }, // seed
          { grapheme: 'ल', score: 1 }, // seed
        ],
      }),
    );
    expect(word).toBe('सूरज');
  });
});

// ─── selectNextWord SQL — timed-out words must not count toward progression ──
//
// Regression guard for the word-length timeout bug: a user could time out on
// a word (leaving rows but never completing it), get a fresh word, time out
// again, and after 3 such words the old query counted 3 unique words in the
// add window and promoted them to longer words they never read. The fix
// counts a word in the progression windows only when it has a row whose
// xstate snapshot reached status 'done' (the machine's `complete` final
// state). dataSource.query is mocked here, so these tests assert the query
// shape directly — if the snapshot format or the machine's final state ever
// changes, update the SQL and these assertions together.

describe('LiteracyLessonService — selectNextWord SQL (timeout progression regression)', () => {
  async function capturedSql(): Promise<string> {
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
      .mockResolvedValueOnce([{ id: 'lls-1' }]);
    const { svc } = makeService({ repo, dsQuery });
    await svc.processAnswer({ user, user_message_id: 'mm-1' });
    // First round-trip is selectNextWord's single query.
    return (dsQuery.mock.calls[0][0] as string).replace(/\s+/g, ' ');
  }

  it('derives is_done from the xstate snapshot final-state status', async () => {
    const sql = await capturedSql();
    expect(sql).toContain("(snapshot->>'status' = 'done') AS is_done");
  });

  it('add window counts only completed words', async () => {
    const sql = await capturedSql();
    expect(sql).toContain(
      'COUNT(DISTINCT word)::int FROM recent_rows WHERE rn <= $4 AND is_done',
    );
  });

  it('keep window counts only completed words', async () => {
    const sql = await capturedSql();
    expect(sql).toContain(
      'COUNT(DISTINCT word)::int FROM recent_rows WHERE is_done',
    );
  });

  it('recent_row_count still counts ALL rows — the new-user gate must see timed-out attempts', async () => {
    const sql = await capturedSql();
    expect(sql).toContain(
      'COUNT(*)::int FROM recent_rows), 0) AS recent_row_count',
    );
  });

  it('recent-word exclusion list is NOT completion-filtered — a timed-out word must not repeat immediately', async () => {
    const sql = await capturedSql();
    const cte = sql.slice(
      sql.indexOf('recent_distinct_words AS ('),
      sql.indexOf('recent_rows AS ('),
    );
    expect(cte.length).toBeGreaterThan(0);
    expect(cte).not.toContain('done');
  });
});

// ─── word-length decisions on timeout-shaped histories ──────────────────────
//
// Exact max-length assertions (via the pp.lesson.word.max_length span
// attribute) for the DB-row shapes the fixed query now produces.

describe('LiteracyLessonService — word-length decisions on timeout-shaped histories', () => {
  function expectMaxLength(len: number) {
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.word.max_length',
      len,
    ]);
  }

  it('serial timeouts: window full of rows but zero completed words → length regresses', async () => {
    // Pre-fix a 3-timed-out-word history returned unique_in_add_window: 3
    // and promoted the user; post-fix the query returns 0 completed words.
    await selectedWord(
      freshRow({
        distinct_word_count: 5,
        recent_row_count: 8,
        recent_words: ['कमल'], // len 3
        unique_in_add_window: 0,
        unique_in_keep_window: 0,
      }),
    );
    expectMaxLength(2);
  });

  it('serial timeouts at the floor: regression never goes below 2', async () => {
    await selectedWord(
      freshRow({
        distinct_word_count: 5,
        recent_row_count: 8,
        recent_words: ['अब'], // len 2, already at floor
        unique_in_add_window: 0,
        unique_in_keep_window: 0,
      }),
    );
    expectMaxLength(2);
  });

  it('3 completed words inside the add window → length increases by exactly 1', async () => {
    await selectedWord(
      freshRow({
        distinct_word_count: 5,
        recent_row_count: 8,
        recent_words: ['कमल'], // len 3
        unique_in_add_window: 3,
        unique_in_keep_window: 3,
      }),
    );
    expectMaxLength(4);
  });

  it('completions only in the keep window (recent timeouts after older completions) → length holds', async () => {
    await selectedWord(
      freshRow({
        distinct_word_count: 5,
        recent_row_count: 15,
        recent_words: ['कमल'], // len 3
        unique_in_add_window: 1,
        unique_in_keep_window: 3,
      }),
    );
    expectMaxLength(3);
  });
});

// ─── sentence lessons (selectNextString level > 7) ───────────────────────────

// Drives a fresh start with `row` from the selectNextString query and returns
// { out, input, dsQuery } where `input` is what createActor was seeded with.
async function freshSentenceStart(
  row: Record<string, unknown>,
  snapshot: unknown = happySnapshot(),
): Promise<{
  out: {
    stateTransitionIds: string[];
    isComplete: boolean;
    sentenceText?: string;
  };
  input: { word: string; sentence?: string[]; userMessageId: string };
  dsQuery: jest.Mock;
}> {
  xstateMock.createActor.mockClear();
  const dsQuery = jest
    .fn()
    .mockResolvedValueOnce([row]) // selectNextString
    .mockResolvedValueOnce([{ id: 'lls-1' }]); // INSERT
  mockActorGetSnapshot.mockReturnValue(snapshot);
  const repo = makeRepo();
  repo.findOne.mockResolvedValue(null);
  const { svc } = makeService({ repo, dsQuery });
  const out = await svc.processAnswer({ user, user_message_id: 'mm-1' });
  const input = xstateMock.createActor.mock.calls[0][1].input as {
    word: string;
    sentence?: string[];
    userMessageId: string;
  };
  return { out, input, dsQuery };
}

// Progression prerequisites so the level derives from recent_words[0].
const progressed = (over: Record<string, unknown>) =>
  freshRow({
    distinct_word_count: 10,
    recent_row_count: 15,
    unique_in_add_window: 0,
    unique_in_keep_window: 3, // keep the current level
    ...over,
  });

describe('LiteracyLessonService.selectNextString — sentence branch', () => {
  it('level 8 (7-grapheme word + progression) → a 2-word sentence from the list', async () => {
    const { input } = await freshSentenceStart(
      progressed({
        recent_words: ['चौकीदार'], // 7 graphemes → level 7, +1 → 8
        unique_in_add_window: 3,
      }),
    );
    expect(input.word).toBe('');
    expect(input.sentence).toHaveLength(2);
    for (const w of input.sentence!) {
      expect(TEST_WORD_LIST).toContain(w);
    }
    expect(new Set(input.sentence).size).toBe(2); // distinct words
  });

  it('derives the level from a stored sentence (2 words = 8, +1 → 9 → 4 words)', async () => {
    const { input } = await freshSentenceStart(
      progressed({
        recent_words: ['अब कमल'],
        unique_in_add_window: 3,
      }),
    );
    expect(input.sentence).toHaveLength(4);
  });

  it('handles punctuation inside a stored sentence for both level and recency', async () => {
    const { input } = await freshSentenceStart(
      progressed({
        recent_words: ['अब, कमल।'], // still 2 words → level 8; keep → 2-word sentence
      }),
    );
    expect(input.sentence).toHaveLength(2);
    // Recency exclusion must see the clean words despite the punctuation.
    expect(input.sentence).not.toContain('अब');
    expect(input.sentence).not.toContain('कमल');
  });

  it('excludes every word used by recent sentences from the new pick', async () => {
    const { input } = await freshSentenceStart(
      progressed({
        recent_words: ['दीवार किताब', 'सूरज पानी'],
      }),
    );
    // level of 'दीवार किताब' = 8 → keep → 2 words from the 3 not recently used.
    expect(input.sentence).toHaveLength(2);
    for (const w of input.sentence!) {
      expect(['अब', 'कमल', 'खाना']).toContain(w);
    }
  });

  it('clamps the level at 12 (kills level+1 running away)', async () => {
    const thirtyTwo = Array.from({ length: 32 }, (_, i) => `w${i}`).join(' ');
    await freshSentenceStart(
      progressed({
        recent_words: [thirtyTwo], // level 12
        unique_in_add_window: 3, // wants 13 → clamped
      }),
    );
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.word.max_length',
      12,
    ]);
  });

  it('tops up ignoring recency when the non-recent pool is too small, and warns', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { input } = await freshSentenceStart(
      progressed({
        // 4 words → level 9 → needs 4; only 3 of 7 list words are non-recent.
        recent_words: ['कमल पानी खाना अब'],
      }),
    );
    expect(input.sentence).toHaveLength(4);
    expect(new Set(input.sentence).size).toBe(4);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('topping up ignoring recency'),
    );
    warnSpy.mockRestore();
  });

  it('stays a word lesson at level 7 and below', async () => {
    const { input } = await freshSentenceStart(
      progressed({
        recent_words: ['दीवार'], // 5 graphemes, keep → level 5
      }),
    );
    expect(input.sentence).toBeUndefined();
    expect(input.word).not.toBe('');
  });
});

describe('LiteracyLessonService.processAnswer — sentence persistence + result', () => {
  const sentenceSnapshot = (value: string) =>
    happySnapshot({
      value,
      context: {
        word: '',
        sentence: ['अब', 'कमल'],
        pendingCorrect: [],
        pendingIncorrect: [],
        answer: 'अब कमल',
        answerCorrect: null,
        stateTransitionId: 'sentence-start-sentence-initial',
      },
    });

  it('persists the space-joined sentence in the word column', async () => {
    const { dsQuery } = await freshSentenceStart(
      progressed({ recent_words: ['चौकीदार'], unique_in_add_window: 3 }),
      sentenceSnapshot('sentence'),
    );
    const insertParams = dsQuery.mock.calls[1][1] as unknown[];
    expect(insertParams[2]).toBe('अब कमल');
  });

  it('returns sentenceText when the machine sits in the sentence state', async () => {
    const { out } = await freshSentenceStart(
      progressed({ recent_words: ['चौकीदार'], unique_in_add_window: 3 }),
      sentenceSnapshot('sentence'),
    );
    expect(out.sentenceText).toBe('अब कमल');
  });

  it('returns no sentenceText while a word is being drilled', async () => {
    const { out } = await freshSentenceStart(
      progressed({ recent_words: ['चौकीदार'], unique_in_add_window: 3 }),
      sentenceSnapshot('word'),
    );
    expect(out.sentenceText).toBeUndefined();
  });

  it('returns no sentenceText for a plain word lesson', async () => {
    const { out } = await freshSentenceStart(freshRow());
    expect(out.sentenceText).toBeUndefined();
  });
});

describe('LiteracyLessonService — sentence observability (kills literal mutants)', () => {
  it('logs the sentence selection summary with words joined by spaces', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const { input } = await freshSentenceStart(
      progressed({ recent_words: ['चौकीदार'], unique_in_add_window: 3 }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `selectNextString: sentence selected=${input.sentence!.join(' ')} level=8 words=2`,
      ),
    );
    logSpy.mockRestore();
  });

  it('tags the sentence selection span attributes', async () => {
    const { input } = await freshSentenceStart(
      progressed({ recent_words: ['चौकीदार'], unique_in_add_window: 3 }),
    );
    const calls = mockSpanSetAttribute.mock.calls;
    expect(calls).toContainEqual([
      'pp.lesson.word.selection',
      'sentence-random',
    ]);
    expect(calls).toContainEqual(['pp.lesson.word.count', 2]);
    expect(calls).toContainEqual([
      'pp.lesson.word.selected',
      input.sentence!.join(' '),
    ]);
  });

  it('tags pp.lesson.sentence when the result carries sentenceText', async () => {
    await freshSentenceStart(
      progressed({ recent_words: ['चौकीदार'], unique_in_add_window: 3 }),
      happySnapshot({
        value: 'sentence',
        context: {
          word: '',
          sentence: ['अब', 'कमल'],
          pendingCorrect: [],
          pendingIncorrect: [],
          answer: 'अब कमल',
          answerCorrect: null,
          stateTransitionId: 'sentence-start-sentence-initial',
        },
      }),
    );
    expect(mockSpanSetAttribute.mock.calls).toContainEqual([
      'pp.lesson.sentence',
      'अब कमल',
    ]);
  });
});
