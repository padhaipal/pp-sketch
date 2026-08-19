import {
  READ_ERROR_BUDGET_MIN,
  READ_ERROR_BUDGET_RATIO,
  aksharaDistance,
  assessSentence,
  readErrorBudget,
  selectDrillWord,
} from './sentence-assessment';

// A pool of distinct, teachable, mutually-distant words to build long
// passages from (each ≥2 akshara from the others so cross-matches never
// blur the alignment).
const WORD_POOL = [
  'घर',
  'नल',
  'कमल',
  'सड़क',
  'बादल',
  'पहाड़',
  'नदी',
  'सागर',
  'कलम',
  'पतंग',
];

function passage(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const base = WORD_POOL[i % WORD_POOL.length];
    // Suffix numbering keeps words distinct: use danda-free Devanagari digits
    // is overkill — repeat pool words with different neighbors instead.
    return base;
  });
}

describe('aksharaDistance', () => {
  it('हिंदी vs हिन्दी → 0 (conjunct nasal ↔ anusvara is orthographic, not an error)', () => {
    expect(aksharaDistance('हिंदी', 'हिन्दी')).toBe(0);
  });

  it('हँसी vs हंसी → 0 (chandrabindu ↔ anusvara)', () => {
    expect(aksharaDistance('हँसी', 'हंसी')).toBe(0);
  });

  it('ज़िंदगी vs जिंदगी → 0 (optional nukta)', () => {
    expect(aksharaDistance('ज़िंदगी', 'जिंदगी')).toBe(0);
  });

  it('क्या vs कया → 2 (grapheme clusters, not code units)', () => {
    expect(aksharaDistance('क्या', 'कया')).toBe(2);
  });

  it('कि vs की → 1 (single-cluster matra difference)', () => {
    expect(aksharaDistance('कि', 'की')).toBe(1);
  });

  it('word pairs that concatenate identically never collide on the memo cache', () => {
    // "अब"+"कद" and "अबक"+"द" both naively concatenate to "अबकद"; with the
    // control-character key separator they are distinct cache entries.
    // Populate the first pair's entry, then assert the second is computed
    // independently — and re-assert both after caching.
    expect(aksharaDistance('अब', 'कद')).toBe(2);
    expect(aksharaDistance('अबक', 'द')).toBe(3);
    expect(aksharaDistance('अब', 'कद')).toBe(2);
    expect(aksharaDistance('अबक', 'द')).toBe(3);
  });
});

describe('readErrorBudget', () => {
  it('is 10% rounded up with a floor of one', () => {
    expect(READ_ERROR_BUDGET_RATIO).toBe(0.1);
    expect(READ_ERROR_BUDGET_MIN).toBe(1);
    expect(readErrorBudget(9)).toBe(1); // bare 10% would round to zero
    expect(readErrorBudget(100)).toBe(10);
    expect(readErrorBudget(15)).toBe(2);
  });
});

describe('assessSentence', () => {
  it('passes a verbatim read', () => {
    const words = ['घर', 'में', 'नल', 'है'];
    const result = assessSentence({
      words,
      transcripts: ['घर में नल है'],
    });
    expect(result.passed).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.accuracy).toBe(1);
    expect(result.words.map((w) => w.status)).toEqual([
      'correct',
      'correct',
      'correct',
      'correct',
    ]);
  });

  it('tolerates trailing and leading junk tokens', () => {
    const words = ['घर', 'में', 'नल', 'है'];
    const result = assessSentence({
      words,
      transcripts: ['सुनो बच्चों घर में नल है ठीक पढ़ा'],
    });
    expect(result.passed).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it('tolerates mid-passage disfluency', () => {
    const words = ['घर', 'में', 'नल', 'है'];
    const result = assessSentence({
      words,
      transcripts: ['घर में उम्म नल है'],
    });
    expect(result.passed).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it('tolerates self-correction (बिल्ली बिल्ला बिल्ली)', () => {
    const words = ['बिल्ली', 'दूध', 'पीती', 'है'];
    const result = assessSentence({
      words,
      transcripts: ['बिल्ली बिल्ला बिल्ली दूध पीती है'],
    });
    expect(result.passed).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.words[0].status).toBe('correct');
  });

  it('a single omission in a 100-word passage passes (within budget)', () => {
    const words = passage(100);
    const spoken = words.slice(0, 50).concat(words.slice(51));
    const result = assessSentence({
      words,
      transcripts: [spoken.join(' ')],
    });
    expect(result.errorCount).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('15 omissions in a 100-word passage fail', () => {
    const words = passage(100);
    // Drop one full pool cycle + 5 more words: 15 omissions. Because pool
    // words repeat every 10, drop 15 CONSECUTIVE words so the aligner cannot
    // re-purpose neighbors.
    const spoken = words.slice(0, 40).concat(words.slice(55));
    const result = assessSentence({
      words,
      transcripts: [spoken.join(' ')],
    });
    expect(result.errorCount).toBeGreaterThanOrEqual(15 - 5); // repeats may re-align
    expect(result.errorCount).toBeGreaterThan(readErrorBudget(100));
    expect(result.passed).toBe(false);
  });

  it('one word at akshara distance 2 in a 9-word passage passes (max(1, …) floor)', () => {
    const words = ['घर', 'में', 'नल', 'है', 'और', 'बादल', 'पानी', 'देता', 'है'];
    const result = assessSentence({
      words,
      // क्या for नल: distance ≥ 2 → substitution.
      transcripts: ['घर में क्या है और बादल पानी देता है'],
    });
    expect(result.words[2].status).toBe('substituted');
    expect(result.errorCount).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('labels an adjacent swap transposed, not two substitutions, counting the pair as ONE error', () => {
    const words = ['नल', 'घर', 'में', 'है'];
    const result = assessSentence({
      words,
      transcripts: ['घर नल में है'],
    });
    expect(result.words[0].status).toBe('transposed');
    expect(result.words[1].status).toBe('transposed');
    // A transposition is a decoding error — one per PAIR, not per word.
    expect(result.errorCount).toBe(1);
    // Budget for 4 words is max(1, ceil(0.4)) = 1, so a single swap still passes.
    expect(result.passed).toBe(true);
  });

  it('counts two transposed pairs as two errors', () => {
    const words = ['नल', 'घर', 'कलम', 'पतंग', 'सागर', 'बादल'];
    const result = assessSentence({
      words,
      transcripts: ['घर नल कलम पतंग बादल सागर'],
    });
    expect(result.words.map((w) => w.status)).toEqual([
      'transposed',
      'transposed',
      'correct',
      'correct',
      'transposed',
      'transposed',
    ]);
    expect(result.errorCount).toBe(2);
    // Budget for 6 words is 1 — two transposed pairs now fail the read.
    expect(result.passed).toBe(false);
  });

  it('हिंदी target matched by हिन्दी transcript is correct', () => {
    const result = assessSentence({
      words: ['हिंदी', 'पढ़ो'],
      transcripts: ['हिन्दी पढ़ो'],
    });
    expect(result.words[0].status).toBe('correct');
    expect(result.words[0].aksharaDistance).toBe(0);
  });

  it('close reads (akshara distance 1) are not errors', () => {
    const result = assessSentence({
      words: ['कमल', 'सुंदर', 'है'],
      transcripts: ['कमला सुंदर है'],
    });
    expect(result.words[0].status).toBe('close');
    expect(result.errorCount).toBe(0);
    expect(result.passed).toBe(true);
  });

  it('fuses per word across engines: any engine hearing a word correctly wins', () => {
    const words = ['घर', 'में', 'नल', 'है', 'बादल'];
    const engineA = 'घर में क्या है बादल'; // wrong on word 3 (नल)
    const engineB = 'घर में नल है क्या'; // right on word 3, wrong on word 5
    const result = assessSentence({
      words,
      transcripts: [engineA, engineB],
    });
    expect(result.words[2].status).toBe('correct'); // नल — engine B heard it
    expect(result.words[4].status).toBe('correct'); // बादल — engine A heard it
    expect(result.errorCount).toBe(0);
  });

  it('never concatenates engines across the ~ seam', () => {
    // Combined fallback string: neither half alone contains the sentence.
    const words = ['घर', 'में', 'नल', 'है'];
    const result = assessSentence({
      words,
      transcripts: ['घर में ~ नल है'],
    });
    // Each segment aligns independently: segment 1 hears words 1-2,
    // segment 2 hears words 3-4 — fusion still marks all four correct
    // per-word (per-WORD fusion is exactly the point).
    expect(result.words.map((w) => w.status)).toEqual([
      'correct',
      'correct',
      'correct',
      'correct',
    ]);
  });

  it('is deterministic: identical input yields identical output across runs', () => {
    const args = {
      words: ['घर', 'में', 'नल', 'है', 'और', 'बादल'],
      transcripts: ['घर मे नल क्या और बादल', 'घर में नल है और'],
    };
    const first = JSON.stringify(assessSentence(args));
    for (let i = 0; i < 20; i++) {
      expect(JSON.stringify(assessSentence(args))).toBe(first);
    }
  });

  it('empty transcripts → everything omitted, failed', () => {
    const result = assessSentence({ words: ['घर', 'नल'], transcripts: [''] });
    expect(result.words.every((w) => w.status === 'omitted')).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('empty words → failed, empty evidence', () => {
    const result = assessSentence({ words: [], transcripts: ['घर'] });
    expect(result.passed).toBe(false);
    expect(result.words).toEqual([]);
  });
});

describe('selectDrillWord', () => {
  it('picks the substituted/omitted teachable word with the highest akshara distance', () => {
    const assessment = assessSentence({
      words: ['घर', 'में', 'पतंग', 'है'],
      transcripts: ['घर में है'], // पतंग omitted (distance = its length)
    });
    expect(selectDrillWord(assessment.words)).toBe('पतंग');
  });

  it('never picks close or correct words', () => {
    const assessment = assessSentence({
      words: ['कमल', 'सुंदर', 'है'],
      transcripts: ['कमला सुंदर है'],
    });
    expect(selectDrillWord(assessment.words)).toBeNull();
  });

  it('returns null when every failing word is unteachable', () => {
    // क्या contains halant — not in TEACHABLE_GRAPHEMES.
    const assessment = assessSentence({
      words: ['क्या', 'सुंदर', 'है'],
      transcripts: ['सुंदर है'],
    });
    expect(assessment.words[0].status).toBe('omitted');
    expect(assessment.words[0].teachable).toBe(false);
    expect(selectDrillWord(assessment.words)).toBeNull();
  });

  it('random tie-break always picks a qualifying word', () => {
    const assessment = assessSentence({
      words: ['घर', 'नल', 'कमल'],
      transcripts: ['कमल'], // घर and नल omitted, both distance 2
    });
    for (let i = 0; i < 40; i++) {
      expect(['घर', 'नल']).toContain(selectDrillWord(assessment.words));
    }
  });
});
