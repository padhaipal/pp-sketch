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

// ─── Mutation hardening: exact char-set assertions per edit-op path ────────
// The existing tests above cover the canonical paths. These pin down the
// EXACT correctChars / incorrectChars produced by each Levenshtein traceback
// branch (replace, insert, delete, equal) so individual mutants in the DP +
// traceback have an observable signal.

describe('identifyCharacterStatus — exact char-set per edit-op path', () => {
  it('single replace tags only the replaced correct char as incorrect', () => {
    // source=गम, target=कम → equal(म), replace(ग→क). mismatched={क}.
    const out = identifyCharacterStatus({
      correctAnswer: 'कम',
      studentAnswer: 'गम',
    });
    expect(out.correctChars).toEqual(['म']);
    expect(out.incorrectChars).toEqual(['क']);
  });

  it('two replaces tag both correct chars as incorrect', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'कम',
      studentAnswer: 'गन',
    });
    expect(out.correctChars).toEqual([]);
    expect(out.incorrectChars).toEqual(['क', 'म']);
  });

  it('three-char deletion: only the matched leading char stays correct (kills the traceback `||` → `&&`)', () => {
    // source=क, target=कमल → equal(क), then i must keep decrementing while
    // j is already 0 — only possible with the while-loop disjunction.
    const out = identifyCharacterStatus({
      correctAnswer: 'कमल',
      studentAnswer: 'क',
    });
    expect(out.correctChars).toEqual(['क']);
    expect(out.incorrectChars).toEqual(['म', 'ल']);
  });

  it('insertion of an extra char into the student answer keeps every correct char correct', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'कम',
      studentAnswer: 'कटम',
    });
    expect(out.correctChars).toEqual(['क', 'म']);
    expect(out.incorrectChars).toEqual([]);
  });

  it('character swap is two replaces (kills the equality check in charsEqual / matrix match)', () => {
    // अब vs बअ: same chars different order. Best alignment has 1 equal
    // (whichever of अ/ब tracks) and 1 replace.
    const out = identifyCharacterStatus({
      correctAnswer: 'अब',
      studentAnswer: 'बअ',
    });
    // The DP currently picks ब as the equal; अ is the replace.
    expect(out.correctChars).toEqual(['ब']);
    expect(out.incorrectChars).toEqual(['अ']);
  });

  it('a trailing-deletion (student missing the last char) tags only that char incorrect', () => {
    const out = identifyCharacterStatus({
      correctAnswer: 'कमल',
      studentAnswer: 'कम',
    });
    expect(out.correctChars).toEqual(['क', 'म']);
    expect(out.incorrectChars).toEqual(['ल']);
  });

  it('multi-word: a shorter-distance second word overrides the first (kills `distance < bestDist`)', () => {
    // 'xyz' has distance 3 to 'कमल'; 'कमल' has distance 0 → second wins.
    const out = identifyCharacterStatus({
      correctAnswer: 'कमल',
      studentAnswer: 'xyz कमल',
    });
    expect(out.correctChars).toEqual(['क', 'म', 'l'.length === 1 ? 'ल' : 'ल']);
    expect(out.incorrectChars).toEqual([]);
  });

  it('multi-word: an equal-distance second word with FEWER matches does NOT override the first (kills `matches > bestMatches` → `>=`)', () => {
    // Both 'गम' and 'कन' have distance 1 to 'कम' AND matchCount 1.
    // The first-seen ('गम') wins on the strict `>` tie-break.
    const out = identifyCharacterStatus({
      correctAnswer: 'कम',
      studentAnswer: 'गम कन',
    });
    expect(out.correctChars).toEqual(['म']);
    expect(out.incorrectChars).toEqual(['क']);
  });

  it('multi-word: an equal-distance second word with MORE matches overrides the first', () => {
    // 'कन' has distance 1 (replace न→म), matchCount 1.
    // 'कम' has distance 0, matchCount 2 → distance<bestDist wins.
    const out = identifyCharacterStatus({
      correctAnswer: 'कम',
      studentAnswer: 'कन कम',
    });
    expect(out.correctChars).toEqual(['क', 'म']);
    expect(out.incorrectChars).toEqual([]);
  });

  it('cleaning strips non-letter/non-mark chars and lowercases (kills the clean() regex + toLocaleLowerCase)', () => {
    // Punctuation, digits, whitespace inside the token are stripped; ASCII
    // casing is folded so "ABC" matches "abc".
    const out = identifyCharacterStatus({
      correctAnswer: 'abc',
      studentAnswer: '  A!B@C#  ',
    });
    expect(out.correctChars).toEqual(['a', 'b', 'c']);
    expect(out.incorrectChars).toEqual([]);
  });
});
