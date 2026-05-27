import { identifyCharacterStatus } from './identify-character-status.utils';

// identifyCharacterStatus runs a Levenshtein traceback to classify which
// distinct characters of `correctAnswer` were successfully matched (in some
// order) by any of the space-separated words in `studentAnswer`. It returns
// the same character-set partitioned into `correctChars` / `incorrectChars`
// (subsets of the correctAnswer character set, deduped via Set).

describe('identifyCharacterStatus — exact match', () => {
  it('marks every character correct when the answer is identical', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'क',
      studentAnswer: 'क',
    });
    expect(out.correctChars).toEqual(['क']);
    expect(out.incorrectChars).toEqual([]);
  });

  it('marks every character correct for a multi-character exact match', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'कमल',
      studentAnswer: 'कमल',
    });
    expect(new Set(out.correctChars)).toEqual(new Set(['क', 'म', 'ल']));
    expect(out.incorrectChars).toEqual([]);
  });
});

describe('identifyCharacterStatus — normalization', () => {
  it('NFC-normalizes inputs so combined-form student answers still match', () => {
    // Both arguments should fold to NFC form; mismatched composition would
    // otherwise mark every grapheme as wrong.
    const correct = 'क'.normalize('NFD');
    const student = 'क'.normalize('NFC');
    const out = identifyCharacterStatus({
      correctAnswer: correct,
      studentAnswer: student,
    });
    expect(out.incorrectChars).toEqual([]);
  });

  it('strips punctuation and whitespace from each comparison', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'क!',
      studentAnswer: 'क,',
    });
    // Punctuation is stripped by clean(); the remaining 'क' matches.
    // Note that the correctAnswer character set still contains '!' but
    // the function only iterates the cleaned form for the output set.
    expect(out.correctChars).toContain('क');
  });

  it('is case-insensitive (locale lower-case)', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'CAT',
      studentAnswer: 'cat',
    });
    expect(new Set(out.correctChars)).toEqual(new Set(['c', 'a', 't']));
    expect(out.incorrectChars).toEqual([]);
  });
});

describe('identifyCharacterStatus — partial match', () => {
  it('classifies a single replaced character as incorrect, the rest as correct', () => {
    // correct: कमल, student: कनल — middle char replaced
    const out = identifyCharacterStatus({
      correctAnswer: 'कमल',
      studentAnswer: 'कनल',
    });
    expect(out.incorrectChars).toEqual(['म']);
    expect(new Set(out.correctChars)).toEqual(new Set(['क', 'ल']));
  });

  it('a fully-wrong student answer (no shared chars) marks every char incorrect', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'abc',
      studentAnswer: 'xyz',
    });
    expect(out.correctChars).toEqual([]);
    expect(new Set(out.incorrectChars)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('handles insertions (extra char in student answer) without false-flagging the correct chars', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'कल',
      studentAnswer: 'कमल', // extra 'म' inserted
    });
    expect(new Set(out.correctChars)).toEqual(new Set(['क', 'ल']));
    expect(out.incorrectChars).toEqual([]);
  });

  it('handles deletions (missing char in student answer) by marking the missing char incorrect', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'कमल',
      studentAnswer: 'कल', // 'म' missing
    });
    expect(out.incorrectChars).toEqual(['म']);
    expect(new Set(out.correctChars)).toEqual(new Set(['क', 'ल']));
  });
});

describe('identifyCharacterStatus — multiple student words', () => {
  it('picks the best-matching word from a multi-word student answer', () => {
    // Two words: 'foo' (totally wrong) and 'cat' (perfect). The function
    // must pick the better one.
    const out = identifyCharacterStatus({
      correctAnswer: 'cat',
      studentAnswer: 'foo cat',
    });
    expect(new Set(out.correctChars)).toEqual(new Set(['c', 'a', 't']));
    expect(out.incorrectChars).toEqual([]);
  });

  it('breaks ties by preferring the candidate with more equal-ops (higher matchCount)', () => {
    // Both candidates have distance 1; the second has more matched chars.
    // The implementation tracks `bestMatches` to break ties.
    const out = identifyCharacterStatus({
      correctAnswer: 'cat',
      // 'x' has distance 3 (replace all); 'cax' has distance 1 with 2 matches
      studentAnswer: 'x cax',
    });
    expect(new Set(out.correctChars)).toEqual(new Set(['c', 'a']));
    expect(out.incorrectChars).toEqual(['t']);
  });
});

describe('identifyCharacterStatus — output set invariants', () => {
  it('correctChars and incorrectChars together cover exactly the distinct chars of the cleaned correctAnswer', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'कमल',
      studentAnswer: 'xyz',
    });
    const union = new Set([...out.correctChars, ...out.incorrectChars]);
    expect(union).toEqual(new Set(['क', 'म', 'ल']));
  });

  it('correctChars and incorrectChars are disjoint', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'abcabc',
      studentAnswer: 'abc',
    });
    const inter = out.correctChars.filter((c) =>
      out.incorrectChars.includes(c),
    );
    expect(inter).toEqual([]);
  });

  it('outputs distinct characters only — duplicates in the correct answer are deduped via Set', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'aaa',
      studentAnswer: 'aaa',
    });
    expect(out.correctChars).toEqual(['a']); // not ['a','a','a']
  });
});
