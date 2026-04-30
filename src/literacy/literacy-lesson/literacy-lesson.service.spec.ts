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
    (word) => graphemeLength(word) <= maxLength && !recentWords.includes(word),
  );
}

function isReviewedScore(score: number): boolean {
  return !Number.isInteger(score * 2);
}

function computeBaseline(letterScores: LetterScores): number {
  const reviewed = Object.values(letterScores).filter(isReviewedScore);
  if (reviewed.length === 0) return 0;
  return reviewed.reduce((sum, v) => sum + v, 0) / reviewed.length;
}

function scoreWord(word: string, letterScores: LetterScores): number {
  const baseline = computeBaseline(letterScores);
  return Array.from(word).reduce((sum, letter) => {
    const score = letterScores[letter];
    if (score === undefined) return sum;
    if (isReviewedScore(score)) return sum + (score - baseline);
    return sum + score;
  }, 0);
}

function minScoredCandidatesFromPrompt(row: SelectNextWordRow): string[] {
  const candidates = candidateWordsFromPrompt(row);
  const letterScores = getLetterScores(row);

  if (candidates.length === 0) {
    return [];
  }

  const SCORE_EPS = 1e-9;
  const scored = candidates.map((word) => ({
    word,
    score: scoreWord(word, letterScores),
  }));
  const minScore = Math.min(...scored.map((s) => s.score));
  const minTies = scored.filter(
    (s) => Math.abs(s.score - minScore) < SCORE_EPS,
  );
  const maxLen = Math.max(...minTies.map((s) => graphemeLength(s.word)));
  return minTies
    .filter((s) => graphemeLength(s.word) === maxLen)
    .map((s) => s.word);
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

    expect(maxLengthFromPrompt(row)).toBe(graphemeLength('इतिहास') + 1);
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

  it('uses 0 default score for unknown letters and logs one WARN', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: {},
    });
    const { service, warnMock } = createServiceHarness(row);

    const selectedWord = await (service as any).selectNextWord('user-6');

    expect(graphemeLength(selectedWord)).toBe(MIN_WORD_LENGTH_FLOOR);
    expect(minScoredCandidatesFromPrompt(row)).toContain(selectedWord);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toContain('unknown grapheme');
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
    const { service, warnMock } = createServiceHarness(row);

    const selectedWord = await (service as any).selectNextWord(
      'user-mixed-fallback',
    );
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
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('uses 0 for unknown graphemes when ranking words', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: {
        क: -1,
      },
    });
    const { service, warnMock } = createServiceHarness(row);

    const selectedWord = await (service as any).selectNextWord(
      'user-unknown-zero',
    );
    const minima = minScoredCandidatesFromPrompt(row);

    expect(minima).toContain(selectedWord);
    expect(warnMock).toHaveBeenCalledTimes(1);
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

    const selectedWord = await (service as any).selectNextWord(
      'user-empty-recent',
    );

    expect(graphemeLength(selectedWord)).toBeLessThanOrEqual(
      MIN_WORD_LENGTH_FLOOR,
    );
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toContain(
      'recent_words is empty',
    );
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

    await expect(
      (service as any).selectNextWord('user-empty-db'),
    ).rejects.toThrow();
  });

  it('throws when the DB row omits expected aggregate fields', async () => {
    const { service } = createServiceHarness(buildRow({}));
    (service as any).dataSource.query = jest.fn().mockResolvedValue([{}]);

    await expect(
      (service as any).selectNextWord('user-missing-fields'),
    ).rejects.toThrow();
  });
});

describe('LiteracyLessonService.selectNextWord — boundary & invariant cases', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('forces MIN floor when recentRowCount=7 even for users with many distinct words', async () => {
    const row = buildRow({
      distinctWordCount: NEW_USER_THRESHOLD + 10,
      uniqueInAddWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      uniqueInKeepWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      recentWords: ['इतिहास'],
      recentRowCount: SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH - 1,
      letterScores: buildUniformLetterScores(1),
    });
    const { service } = createServiceHarness(row);

    const selected = await (service as any).selectNextWord('user-rrc-7');

    expect(maxLengthFromPrompt(row)).toBe(MIN_WORD_LENGTH_FLOOR);
    expect(graphemeLength(selected)).toBeLessThanOrEqual(MIN_WORD_LENGTH_FLOOR);
  });

  it('unlocks dynamic max-length the moment recentRowCount reaches threshold (=8)', async () => {
    const row = buildRow({
      distinctWordCount: NEW_USER_THRESHOLD,
      uniqueInAddWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      uniqueInKeepWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      recentWords: ['ओम'],
      recentRowCount: SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH,
      letterScores: buildUniformLetterScores(1),
    });
    const { service } = createServiceHarness(row);

    const selected = await (service as any).selectNextWord('user-rrc-8');

    expect(maxLengthFromPrompt(row)).toBe(graphemeLength('ओम') + 1);
    expect(graphemeLength(selected)).toBeLessThanOrEqual(
      maxLengthFromPrompt(row),
    );
  });

  it('switches keep→grow exactly at uniqueInAddWindow=3 boundary', () => {
    const recentWords = ['इतिहास'];
    const make = (addWindow: number) =>
      buildRow({
        distinctWordCount: NEW_USER_THRESHOLD + 5,
        uniqueInAddWindow: addWindow,
        uniqueInKeepWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
        recentWords,
        letterScores: buildUniformLetterScores(0),
      });

    expect(maxLengthFromPrompt(make(MIN_UNIQUE_WORDS_FOR_PROGRESS - 1))).toBe(
      graphemeLength('इतिहास'),
    );
    expect(maxLengthFromPrompt(make(MIN_UNIQUE_WORDS_FOR_PROGRESS))).toBe(
      graphemeLength('इतिहास') + 1,
    );
  });

  it('switches shrink→keep exactly at uniqueInKeepWindow=3 boundary', () => {
    const recentWords = ['इतिहास'];
    const make = (keepWindow: number) =>
      buildRow({
        distinctWordCount: NEW_USER_THRESHOLD + 5,
        uniqueInAddWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS - 1,
        uniqueInKeepWindow: keepWindow,
        recentWords,
        letterScores: buildUniformLetterScores(0),
      });

    expect(maxLengthFromPrompt(make(MIN_UNIQUE_WORDS_FOR_PROGRESS - 1))).toBe(
      graphemeLength('इतिहास') - 1,
    );
    expect(maxLengthFromPrompt(make(MIN_UNIQUE_WORDS_FOR_PROGRESS))).toBe(
      graphemeLength('इतिहास'),
    );
  });

  it('selected word always satisfies length ≤ maxLength across mixed scenarios', async () => {
    const scenarios = [
      buildRow({
        distinctWordCount: 0,
        uniqueInAddWindow: 0,
        uniqueInKeepWindow: 0,
        recentWords: [],
        letterScores: buildUniformLetterScores(2),
      }),
      buildRow({
        distinctWordCount: 10,
        uniqueInAddWindow: 5,
        uniqueInKeepWindow: 8,
        recentWords: ['नटखट'],
        letterScores: buildUniformLetterScores(2),
      }),
      buildRow({
        distinctWordCount: 10,
        uniqueInAddWindow: 1,
        uniqueInKeepWindow: 2,
        recentWords: ['कसरत'],
        letterScores: buildUniformLetterScores(2),
      }),
    ];

    for (const row of scenarios) {
      const { service } = createServiceHarness(row);
      const selected = await (service as any).selectNextWord('user-prop');
      expect(graphemeLength(selected)).toBeLessThanOrEqual(
        maxLengthFromPrompt(row),
      );
    }
  });

  it('uses sum (not avg) of letter scores: under uniform negative scores, longest allowed word wins', async () => {
    const row = buildRow({
      distinctWordCount: NEW_USER_THRESHOLD,
      uniqueInAddWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      uniqueInKeepWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      recentWords: ['ओम'],
      letterScores: buildUniformLetterScores(-1),
    });
    const { service } = createServiceHarness(row);

    const selected = await (service as any).selectNextWord('user-sum');

    expect(maxLengthFromPrompt(row)).toBe(3);
    expect(graphemeLength(selected)).toBe(maxLengthFromPrompt(row));
  });

  it('does not mutate wordList across multiple invocations', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: buildUniformLetterScores(1),
    });
    const { service } = createServiceHarness(row);
    const original = [...WORD_LIST];

    await (service as any).selectNextWord('user-immut-1');
    await (service as any).selectNextWord('user-immut-2');
    await (service as any).selectNextWord('user-immut-3');

    expect((service as any).wordList).toEqual(original);
  });

  it('excludes every word in recentWords even when list exceeds RECENT_WORDS_TO_EXCLUDE', async () => {
    const longExclusion = WORD_LIST.filter(
      (word) => graphemeLength(word) === MIN_WORD_LENGTH_FLOOR,
    ).slice(0, RECENT_WORDS_TO_EXCLUDE + 3);
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: longExclusion,
      letterScores: buildUniformLetterScores(1),
    });
    const { service } = createServiceHarness(row);

    const selected = await (service as any).selectNextWord('user-many-recent');

    expect(longExclusion).not.toContain(selected);
  });

  it('runs the SQL summary query exactly once per call, with userId in slot $1', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: buildUniformLetterScores(1),
    });
    const { service, queryMock } = createServiceHarness(row);

    await (service as any).selectNextWord('user-query-once');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [, params] = queryMock.mock.calls[0];
    expect(params[0]).toBe('user-query-once');
    expect(params[1]).toBe(RECENT_WORDS_TO_EXCLUDE);
    expect(params[2]).toBe(SNAPSHOT_THRESHOLD_KEEP_WORD_LENGTH_SAME);
    expect(params[3]).toBe(SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH);
  });

  it('parallel invocations return independent valid candidates', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: buildUniformLetterScores(0),
    });
    const { service, queryMock } = createServiceHarness(row);
    const minima = minScoredCandidatesFromPrompt(row);

    const results = await Promise.all([
      (service as any).selectNextWord('user-c1'),
      (service as any).selectNextWord('user-c2'),
      (service as any).selectNextWord('user-c3'),
    ]);

    expect(queryMock).toHaveBeenCalledTimes(3);
    for (const word of results) {
      expect(minima).toContain(word);
    }
  });

  it('handles a recentWords entry that is not in wordList without skipping a real candidate', async () => {
    const ghostWord = 'नहीं-इस-सूची-में';
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [ghostWord],
      letterScores: buildUniformLetterScores(1),
    });
    const { service } = createServiceHarness(row);

    const selected = await (service as any).selectNextWord('user-ghost');

    expect(WORD_LIST).toContain(selected);
    expect(graphemeLength(selected)).toBeLessThanOrEqual(MIN_WORD_LENGTH_FLOOR);
  });
});

describe('LiteracyLessonService.selectNextWord — baseline & tie-break', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('isReviewedScore: integers and half-integers are seeds; everything else reviewed', () => {
    expect(isReviewedScore(0)).toBe(false);
    expect(isReviewedScore(-100)).toBe(false);
    expect(isReviewedScore(7)).toBe(false);
    expect(isReviewedScore(0.5)).toBe(false);
    expect(isReviewedScore(-2.5)).toBe(false);
    expect(isReviewedScore(1.01)).toBe(true);
    expect(isReviewedScore(-3.001)).toBe(true);
    expect(isReviewedScore(2.02)).toBe(true);
  });

  it('computeBaseline: ignores seed/half scores; averages reviewed scores; 0 when none', () => {
    expect(computeBaseline({})).toBe(0);
    expect(computeBaseline({ क: 0, अ: 2, ब: -1.5 })).toBe(0);
    expect(computeBaseline({ क: 1.01, अ: 5.01 })).toBeCloseTo(3.01, 9);
    expect(computeBaseline({ क: 0, अ: 2, ब: 1.01, न: 5.01 })).toBeCloseTo(
      3.01,
      9,
    );
  });

  it('scoreWord: subtracts baseline only from reviewed letters; seeds use raw; unknown contribute 0', () => {
    const ls: LetterScores = { क: 0, अ: 2, ब: 1.01, न: 5.01 };
    expect(scoreWord('क', ls)).toBe(0);
    expect(scoreWord('अ', ls)).toBe(2);
    expect(scoreWord('ब', ls)).toBeCloseTo(-2, 9);
    expect(scoreWord('न', ls)).toBeCloseTo(2, 9);
    expect(scoreWord('कब', ls)).toBeCloseTo(-2, 9);
    expect(scoreWord('?', ls)).toBe(0);
  });

  it('breaks score ties by selecting the longest word', async () => {
    const recentWords = ['ओम'];
    const row = buildRow({
      distinctWordCount: NEW_USER_THRESHOLD,
      uniqueInAddWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      uniqueInKeepWindow: MIN_UNIQUE_WORDS_FOR_PROGRESS,
      recentWords,
      letterScores: buildUniformLetterScores(0),
    });
    const { service } = createServiceHarness(row);

    const selected = await (service as any).selectNextWord('user-tie-longest');

    expect(maxLengthFromPrompt(row)).toBe(3);
    expect(graphemeLength(selected)).toBe(3);
  });

  it('still picks at random when ties remain after the longest filter', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: buildUniformLetterScores(0),
    });
    const { service } = createServiceHarness(row);

    const randomSpy = jest.spyOn(Math, 'random');
    randomSpy.mockReturnValueOnce(0).mockReturnValueOnce(0.999999);

    const first = await (service as any).selectNextWord('user-tie-rand-1');
    const second = await (service as any).selectNextWord('user-tie-rand-2');

    expect(graphemeLength(first)).toBe(MIN_WORD_LENGTH_FLOOR);
    expect(graphemeLength(second)).toBe(MIN_WORD_LENGTH_FLOOR);
    expect(first).not.toBe(second);
  });

  it('logs baseline and top5 in the selectNextWord log line', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: { क: 1.01, अ: 5.01 },
    });
    const { service } = createServiceHarness(row);
    const logSpy = jest.fn();
    (service as any).logger.log = logSpy;

    await (service as any).selectNextWord('user-baseline-log');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const message = String(logSpy.mock.calls[0][0]);
    expect(message).toMatch(/baseline=3\.010/);
    expect(message).toMatch(/reviewed=2/);
    expect(message).toMatch(/top5=\[/);
  });

  it('baseline=0 logged when no reviewed letters present', async () => {
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: buildUniformLetterScores(0),
    });
    const { service } = createServiceHarness(row);
    const logSpy = jest.fn();
    (service as any).logger.log = logSpy;

    await (service as any).selectNextWord('user-no-reviewed');

    const message = String(logSpy.mock.calls[0][0]);
    expect(message).toMatch(/baseline=0\.000/);
    expect(message).toMatch(/reviewed=0/);
  });

  it('reviewed letter shifted below seeds outranks a same-raw seed', async () => {
    // 'क' seed at 0; 'त' reviewed at 1.01; 'न' reviewed at 7.01.
    // baseline = (1.01 + 7.01) / 2 = 4.01
    // adjusted: क=0 (seed), त=1.01−4.01=−3, न=7.01−4.01=3
    // → 'त' should outrank 'क' as the lowest-scoring single grapheme.
    const row = buildRow({
      distinctWordCount: 0,
      uniqueInAddWindow: 0,
      uniqueInKeepWindow: 0,
      recentWords: [],
      letterScores: { क: 0, त: 1.01, न: 7.01 },
    });

    expect(scoreWord('क', { क: 0, त: 1.01, न: 7.01 })).toBe(0);
    expect(scoreWord('त', { क: 0, त: 1.01, न: 7.01 })).toBeCloseTo(-3, 9);

    const { service } = createServiceHarness(row);
    const minima = minScoredCandidatesFromPrompt(row);
    const selected = await (service as any).selectNextWord('user-baseline-pick');

    expect(minima).toContain(selected);
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
