import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { LiteracyLessonService } from './literacy-lesson.service';
import { STALE_LESSON_RESTART_STATE_TRANSITION_ID } from './literacy-lesson.machine';

const RECENT_WORDS_TO_EXCLUDE = 5;
const SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH = 8;
const SNAPSHOT_THRESHOLD_KEEP_WORD_LENGTH_SAME = 15;
const MIN_UNIQUE_WORDS_FOR_PROGRESS = 3;
const MIN_WORD_LENGTH_FLOOR = 2;
const NEW_USER_THRESHOLD = 3;

type LetterScores = Record<string, number>;
type LetterScoreEntry = { grapheme: string; score: number };

interface SelectNextWordRow {
  letter_scores?: LetterScoreEntry[] | LetterScores;
  letterScores?: LetterScoreEntry[] | LetterScores;
  recent_words?: string[];
  recentWords?: string[];
  unique_in_add_window?: number;
  uniqueInAddWindow?: number;
  unique_in_keep_window?: number;
  uniqueInKeepWindow?: number;
  recent_row_count?: number;
  recentRowCount?: number;
  distinct_word_count?: number;
  distinctWordCount?: number;
}

const WORD_LIST: string[] = JSON.parse(
  readFileSync(path.join(__dirname, 'word-list.json'), 'utf8'),
) as string[];

const TWO_LETTER_WORDS = WORD_LIST.filter(
  (word) => Array.from(word).length === MIN_WORD_LENGTH_FLOOR,
);

function graphemeLength(word: string): number {
  return Array.from(word).length;
}

function getRecentWords(row: SelectNextWordRow): string[] {
  return row.recent_words ?? row.recentWords ?? [];
}

function getLetterScores(row: SelectNextWordRow): LetterScores {
  const rawScores = row.letter_scores ?? row.letterScores ?? {};
  if (Array.isArray(rawScores)) {
    return rawScores.reduce<LetterScores>((acc, entry) => {
      acc[entry.grapheme] = entry.score;
      return acc;
    }, {});
  }
  return rawScores;
}

function getDistinctWordCount(row: SelectNextWordRow): number {
  return row.distinct_word_count ?? row.distinctWordCount ?? 0;
}

function getUniqueInAddWindow(row: SelectNextWordRow): number {
  return row.unique_in_add_window ?? row.uniqueInAddWindow ?? 0;
}

function getUniqueInKeepWindow(row: SelectNextWordRow): number {
  return row.unique_in_keep_window ?? row.uniqueInKeepWindow ?? 0;
}

function getRecentRowCount(row: SelectNextWordRow): number {
  return row.recent_row_count ?? row.recentRowCount ?? 0;
}

function buildRow(input: {
  letterScores?: LetterScores;
  recentWords?: string[];
  uniqueInAddWindow?: number;
  uniqueInKeepWindow?: number;
  recentRowCount?: number;
  distinctWordCount?: number;
}): SelectNextWordRow {
  const letterScoresMap = input.letterScores ?? {};
  const letterScoresEntries = Object.entries(letterScoresMap).map(
    ([grapheme, score]) => ({
      grapheme,
      score,
    }),
  );
  const recentWords = input.recentWords ?? [];
  const uniqueInAddWindow = input.uniqueInAddWindow ?? 0;
  const uniqueInKeepWindow = input.uniqueInKeepWindow ?? 0;
  const recentRowCount =
    input.recentRowCount ?? SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH;
  const distinctWordCount = input.distinctWordCount ?? 0;

  return {
    letter_scores: letterScoresEntries,
    letterScores: letterScoresEntries,
    recent_words: recentWords,
    recentWords,
    unique_in_add_window: uniqueInAddWindow,
    uniqueInAddWindow,
    unique_in_keep_window: uniqueInKeepWindow,
    uniqueInKeepWindow,
    recent_row_count: recentRowCount,
    recentRowCount,
    distinct_word_count: distinctWordCount,
    distinctWordCount,
  };
}

function buildUniformLetterScores(score: number): LetterScores {
  const allLetters = new Set<string>();
  for (const word of WORD_LIST) {
    for (const letter of Array.from(word)) {
      allLetters.add(letter);
    }
  }
  return Array.from(allLetters).reduce<LetterScores>((acc, letter) => {
    acc[letter] = score;
    return acc;
  }, {});
}

function maxLengthFromPrompt(row: SelectNextWordRow): number {
  const distinctWordCount = getDistinctWordCount(row);
  const recentWords = getRecentWords(row);
  const uniqueInAddWindow = getUniqueInAddWindow(row);
  const uniqueInKeepWindow = getUniqueInKeepWindow(row);
  const recentRowCount = getRecentRowCount(row);

  let maxLength: number;

  if (
    distinctWordCount < NEW_USER_THRESHOLD ||
    recentRowCount < SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH ||
    recentWords.length === 0
  ) {
    maxLength = MIN_WORD_LENGTH_FLOOR;
  } else {
    const mostRecentWordLen = graphemeLength(recentWords[0]);
    if (uniqueInAddWindow >= MIN_UNIQUE_WORDS_FOR_PROGRESS) {
      maxLength = mostRecentWordLen + 1;
    } else if (uniqueInKeepWindow >= MIN_UNIQUE_WORDS_FOR_PROGRESS) {
      maxLength = mostRecentWordLen;
    } else {
      maxLength = mostRecentWordLen - 1;
    }
  }

  return Math.max(maxLength, MIN_WORD_LENGTH_FLOOR);
}

function candidateWordsFromPrompt(row: SelectNextWordRow): string[] {
  const maxLength = maxLengthFromPrompt(row);
  const recentWords = getRecentWords(row).slice(0, RECENT_WORDS_TO_EXCLUDE);

  return WORD_LIST.filter(
    (word) =>
      graphemeLength(word) <= maxLength && !recentWords.includes(word),
  );
}

function scoreWord(word: string, letterScores: LetterScores): number {
  return Array.from(word).reduce(
    (sum, letter) => sum + (letterScores[letter] ?? -100),
    0,
  );
}

function minScoredCandidatesFromPrompt(row: SelectNextWordRow): string[] {
  const candidates = candidateWordsFromPrompt(row);
  const letterScores = getLetterScores(row);

  if (candidates.length === 0) {
    return [];
  }

  const minScore = Math.min(
    ...candidates.map((word) => scoreWord(word, letterScores)),
  );

  return candidates.filter((word) => scoreWord(word, letterScores) === minScore);
}

function createServiceHarness(row: SelectNextWordRow): {
  service: LiteracyLessonService;
  queryMock: jest.Mock;
  warnMock: jest.Mock;
} {
  const queryMock = jest.fn().mockResolvedValue([row]);
  const warnMock = jest.fn();

  const service = Object.create(
    LiteracyLessonService.prototype,
  ) as LiteracyLessonService;

  (service as any).dataSource = { query: queryMock };
  (service as any).logger = { warn: warnMock, log: jest.fn() };
  (service as any).wordList = WORD_LIST;

  return { service, queryMock, warnMock };
}

describe('LiteracyLessonService.selectNextWord', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses a single query and returns a minimum-scored candidate for new users', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: buildUniformLetterScores(3),
    });
    const { service, queryMock } = createServiceHarness(row);

    const selectedWord = await (service as any).selectNextWord('user-1');
    const minima = minScoredCandidatesFromPrompt(row);

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
      'user-1',
      RECENT_WORDS_TO_EXCLUDE,
      SNAPSHOT_THRESHOLD_KEEP_WORD_LENGTH_SAME,
      SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH,
    ]);
    expect(graphemeLength(selectedWord)).toBeLessThanOrEqual(
      maxLengthFromPrompt(row),
    );
    expect(minima).toContain(selectedWord);
  });

  it('applies the +1 max-length branch when add-window has enough unique words', async () => {
    const row = buildRow({
      distinctWordCount: NEW_USER_THRESHOLD,
      uniqueInAddWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      uniqueInKeepWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      recentWords: ['इतिहास', 'खरगोश', 'बरसात'],
      letterScores: buildUniformLetterScores(4),
    });
    const { service } = createServiceHarness(row);

    const selectedWord = await (service as any).selectNextWord('user-2');

    expect(maxLengthFromPrompt(row)).toBe(
      graphemeLength('इतिहास') + 1,
    );
    expect(graphemeLength(selectedWord)).toBeLessThanOrEqual(
      maxLengthFromPrompt(row),
    );
    expect(getRecentWords(row)).not.toContain(selectedWord);
    expect(minScoredCandidatesFromPrompt(row)).toContain(selectedWord);
  });

  it('uses the distinct-word threshold boundary exactly at 2 vs 3', async () => {
    const sharedRecentWords = ['इतिहास', 'खरगोश', 'बरसात'];
    const sharedScores = buildUniformLetterScores(3);

    const rowBelowThreshold = buildRow({
      distinctWordCount: NEW_USER_THRESHOLD - 1,
      uniqueInAddWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      uniqueInKeepWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      recentWords: sharedRecentWords,
      letterScores: sharedScores,
    });

    const rowAtThreshold = buildRow({
      distinctWordCount: NEW_USER_THRESHOLD,
      uniqueInAddWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      uniqueInKeepWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      recentWords: sharedRecentWords,
      letterScores: sharedScores,
    });

    const harnessBelow = createServiceHarness(rowBelowThreshold);
    const harnessAt = createServiceHarness(rowAtThreshold);

    const belowWord = await (harnessBelow.service as any).selectNextWord(
      'user-boundary-2',
    );
    const atWord = await (harnessAt.service as any).selectNextWord(
      'user-boundary-3',
    );

    expect(maxLengthFromPrompt(rowBelowThreshold)).toBe(MIN_WORD_LENGTH_FLOOR);
    expect(maxLengthFromPrompt(rowAtThreshold)).toBe(
      graphemeLength(sharedRecentWords[0]) + 1,
    );
    expect(graphemeLength(belowWord)).toBeLessThanOrEqual(
      maxLengthFromPrompt(rowBelowThreshold),
    );
    expect(graphemeLength(atWord)).toBeLessThanOrEqual(
      maxLengthFromPrompt(rowAtThreshold),
    );
  });

  it('keeps max length unchanged when only the keep-window has enough unique words', async () => {
    const recentWords = ['इतिहास', 'खरगोश', 'बरसात'];
    const row = buildRow({
      distinctWordCount: NEW_USER_THRESHOLD + 2,
      uniqueInAddWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS - 1,
      uniqueInKeepWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      recentWords,
      letterScores: buildUniformLetterScores(2),
    });
    const { service } = createServiceHarness(row);

    const selectedWord = await (service as any).selectNextWord('user-3');

    expect(maxLengthFromPrompt(row)).toBe(graphemeLength(recentWords[0]));
    expect(graphemeLength(selectedWord)).toBeLessThanOrEqual(
      maxLengthFromPrompt(row),
    );
    expect(getRecentWords(row)).not.toContain(selectedWord);
    expect(minScoredCandidatesFromPrompt(row)).toContain(selectedWord);
  });

  it('reduces max length by one when neither window has enough unique words and still honors floor', async () => {
    const row = buildRow({
      distinctWordCount: NEW_USER_THRESHOLD + 5,
      uniqueInAddWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS - 1,
      uniqueInKeepWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS - 1,
      recentWords: ['ओम', 'घर', 'अब'],
      letterScores: buildUniformLetterScores(1),
    });
    const { service } = createServiceHarness(row);

    const selectedWord = await (service as any).selectNextWord('user-4');

    expect(maxLengthFromPrompt(row)).toBe(MIN_WORD_LENGTH_FLOOR);
    expect(graphemeLength(selectedWord)).toBeLessThanOrEqual(
      maxLengthFromPrompt(row),
    );
    expect(minScoredCandidatesFromPrompt(row)).toContain(selectedWord);
  });

  it('never returns any of the recent words from the exclusion list', async () => {
    const baselineCandidates = WORD_LIST.filter(
      (word) => graphemeLength(word) <= MIN_WORD_LENGTH_FLOOR,
    );
    const forcedRecentWord = baselineCandidates[0];
    const safeAlternative = baselineCandidates[1];

    const allHighScores = buildUniformLetterScores(10);
    for (const letter of Array.from(forcedRecentWord)) {
      allHighScores[letter] = -50;
    }
    for (const letter of Array.from(safeAlternative)) {
      allHighScores[letter] = 5;
    }

    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [forcedRecentWord],
      letterScores: allHighScores,
    });
    const { service } = createServiceHarness(row);

    const selectedWord = await (service as any).selectNextWord('user-5');

    expect(selectedWord).not.toBe(forcedRecentWord);
    expect(getRecentWords(row)).not.toContain(selectedWord);
  });

  it('uses -100 default score for unknown letters, favoring longer candidates when max length is 2', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: {},
    });
    const { service } = createServiceHarness(row);

    const selectedWord = await (service as any).selectNextWord('user-6');

    expect(graphemeLength(selectedWord)).toBe(MIN_WORD_LENGTH_FLOOR);
    expect(minScoredCandidatesFromPrompt(row)).toContain(selectedWord);
  });

  it('applies partial unknown-letter fallback when only some graphemes have scores', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: {
        क: -150,
      },
    });
    const { service } = createServiceHarness(row);

    const selectedWord = await (service as any).selectNextWord('user-mixed-fallback');
    const minima = minScoredCandidatesFromPrompt(row);

    expect(minima).toContain(selectedWord);
    expect(
      minima.some((word) => {
        const letters = Array.from(word);
        const hasKnown = letters.some((letter) => letter === 'क');
        const hasUnknown = letters.some((letter) => letter !== 'क');
        return hasKnown && hasUnknown;
      }),
    ).toBe(true);
  });

  it('uses -100 for unknown graphemes when ranking words', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: {
        क: -1,
      },
    });
    const { service } = createServiceHarness(row);

    const selectedWord = await (service as any).selectNextWord(
      'user-unknown-minus-100',
    );
    const minima = minScoredCandidatesFromPrompt(row);

    expect(minima).toContain(selectedWord);
  });

  it('falls back safely when recent words are unexpectedly empty for experienced users', async () => {
    const row = buildRow({
      distinctWordCount: NEW_USER_THRESHOLD + 4,
      uniqueInAddWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      uniqueInKeepWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      recentWords: [],
      letterScores: buildUniformLetterScores(1),
    });
    const { service, warnMock } = createServiceHarness(row);

    const selectedWord = await (service as any).selectNextWord('user-empty-recent');

    expect(graphemeLength(selectedWord)).toBeLessThanOrEqual(
      MIN_WORD_LENGTH_FLOOR,
    );
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toContain('recent_words is empty');
  });

  it('uses randomness to break ties between equally scored words', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: buildUniformLetterScores(0),
    });
    const { service } = createServiceHarness(row);

    const randomSpy = jest.spyOn(Math, 'random');
    randomSpy.mockReturnValueOnce(0);
    randomSpy.mockReturnValueOnce(0.999999);

    const firstPick = await (service as any).selectNextWord('user-7');
    const secondPick = await (service as any).selectNextWord('user-7');

    const minima = minScoredCandidatesFromPrompt(row);
    expect(minima).toContain(firstPick);
    expect(minima).toContain(secondPick);
    expect(firstPick).not.toEqual(secondPick);
  });

  it('selects across a wider tie range under varied random values', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: buildUniformLetterScores(0),
    });
    const { service } = createServiceHarness(row);
    const minima = minScoredCandidatesFromPrompt(row);

    const randomSpy = jest.spyOn(Math, 'random');
    randomSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.24)
      .mockReturnValueOnce(0.49)
      .mockReturnValueOnce(0.74)
      .mockReturnValueOnce(0.99);

    const picks = await Promise.all([
      (service as any).selectNextWord('user-random-1'),
      (service as any).selectNextWord('user-random-2'),
      (service as any).selectNextWord('user-random-3'),
      (service as any).selectNextWord('user-random-4'),
      (service as any).selectNextWord('user-random-5'),
    ]);

    for (const pick of picks) {
      expect(minima).toContain(pick);
    }
    expect(new Set(picks).size).toBeGreaterThanOrEqual(3);
  });

  it('falls back to a random two-letter word and logs a warning when no candidates remain', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: WORD_LIST.filter(
        (word) => graphemeLength(word) <= MIN_WORD_LENGTH_FLOOR,
      ),
      letterScores: buildUniformLetterScores(1),
    });
    const { service, warnMock } = createServiceHarness(row);

    jest.spyOn(Math, 'random').mockReturnValue(0);
    const selectedWord = await (service as any).selectNextWord('user-8');

    expect(TWO_LETTER_WORDS).toContain(selectedWord);
    expect(selectedWord).toBe(TWO_LETTER_WORDS[0]);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(typeof warnMock.mock.calls[0][0]).toBe('string');
    expect(warnMock.mock.calls[0][0].length).toBeGreaterThan(0);
  });

  it('throws when the DB query returns no summary row', async () => {
    const { service } = createServiceHarness(buildRow({}));
    (service as any).dataSource.query = jest.fn().mockResolvedValue([]);

    await expect((service as any).selectNextWord('user-empty-db')).rejects.toThrow();
  });

  it('throws when the DB row omits expected aggregate fields', async () => {
    const { service } = createServiceHarness(buildRow({}));
    (service as any).dataSource.query = jest.fn().mockResolvedValue([{}]);

    await expect(
      (service as any).selectNextWord('user-missing-fields'),
    ).rejects.toThrow();
  });
});

describe('LiteracyLessonService.processAnswer contract behaviors', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createProcessAnswerHarness(): {
    service: LiteracyLessonService;
    queryMock: jest.Mock;
    warnMock: jest.Mock;
    gradeAndRecordMock: jest.Mock;
  } {
    const queryMock = jest.fn().mockResolvedValue([{ id: 'state-row' }]);
    const warnMock = jest.fn();
    const gradeAndRecordMock = jest.fn().mockResolvedValue(undefined);

    const service = Object.create(
      LiteracyLessonService.prototype,
    ) as LiteracyLessonService;

    (service as any).lessonStateRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    (service as any).dataSource = { query: queryMock };
    (service as any).scoreService = { gradeAndRecord: gradeAndRecordMock };
    (service as any).logger = { warn: warnMock, error: jest.fn() };
    (service as any).wordList = WORD_LIST;

    return { service, queryMock, warnMock, gradeAndRecordMock };
  }

  it('processes transcript immediately in a fresh lesson when transcript is provided', async () => {
    const { service, queryMock } = createProcessAnswerHarness();
    (service as any).findCurrentState = jest.fn().mockResolvedValue(null);
    (service as any).selectNextWord = jest.fn().mockResolvedValue('ओम');

    const result = await service.processAnswer({
      user: { id: 'user-fresh-transcript' } as any,
      user_message_id: 'media-1',
      transcripts: [{ id: 't1', text: 'ओम' }] as any,
    });

    expect(result.stateTransitionIds.length).toBe(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('marks restart as stale when previous lesson is older than 60 seconds', async () => {
    const { service } = createProcessAnswerHarness();
    (service as any).findCurrentState = jest.fn().mockResolvedValue({
      created_at: new Date(Date.now() - 120_000),
      snapshot: { status: 'active' },
    });
    (service as any).selectNextWord = jest.fn().mockResolvedValue('ओम');

    const result = await service.processAnswer({
      user: { id: 'user-stale-threshold' } as any,
      user_message_id: 'media-2',
    });

    expect(result.stateTransitionIds[0]).toBe(
      STALE_LESSON_RESTART_STATE_TRANSITION_ID,
    );
  });

  it('logs WARN (not ERROR) when insert returns zero rows', async () => {
    const { service, warnMock, queryMock } = createProcessAnswerHarness();
    (service as any).findCurrentState = jest.fn().mockResolvedValue(null);
    (service as any).selectNextWord = jest.fn().mockResolvedValue('ओम');
    queryMock.mockResolvedValue([]);

    await expect(
      service.processAnswer({
        user: { id: 'user-no-insert-row' } as any,
        user_message_id: 'media-3',
      }),
    ).rejects.toThrow('Media was rolled back');

    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
