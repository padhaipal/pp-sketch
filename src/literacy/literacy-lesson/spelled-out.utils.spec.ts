import { identifyCharacterStatus } from './identify-character-status.utils';
import { decodeSpelledOut, identifyWrongLetters } from './spelled-out.utils';

// Transcripts below are real replies from the 20 Oct 2026 log (sarvam and
// azure joined with " ~ ", as the service does).

describe('decodeSpelledOut', () => {
  it('returns nothing for an ordinary answer', () => {
    expect(decodeSpelledOut('नौ। ~ नो।')).toEqual([]);
    expect(decodeSpelledOut('डाक')).toEqual([]);
  });

  it('decodes "<consonant> में <vowel> की मात्रा" into a syllable', () => {
    expect(decodeSpelledOut('ड ड में आ की मात्रा डक डक')).toContain('डा');
  });

  it('joins several syllables and keeps bare consonants said after them', () => {
    const out = decodeSpelledOut('छ छ में आ की मात्रा य य में आ की मात्रा छ य');
    expect(out).toContain('छाया');
    expect(out).toContain('छा');
  });

  it('appends a bare consonant said after the syllable ("डा, क")', () => {
    expect(decodeSpelledOut('ड में आ की मात्रा डा, क')).toContain('डाक');
  });

  it('decodes each transcript separately', () => {
    const out = decodeSpelledOut(
      'ख ख में ओ की मात्रा खोट ~ खा खा में ओ की मात्रा खोड।',
    );
    expect(out).toEqual(['खो']);
  });

  it('reads the engines’ versions of the matra names', () => {
    expect(decodeSpelledOut('ता ता में ओके मात्रा तो')).toContain('तो');
    expect(decodeSpelledOut('पा पा में आपकी मात्रा पा')).toContain('पा');
    expect(decodeSpelledOut('छा छ मेंक माता या।')).toContain('छा');
    expect(decodeSpelledOut('घा घमे की मात्रा घो')).toEqual([]); // no vowel named
  });

  it('reads the classroom names छोटी इ / बड़ी ई / छोटा उ', () => {
    expect(decodeSpelledOut('प प में छोटी की मात्रा')).toContain('पि');
    expect(decodeSpelledOut('प प में बड़ी ई की मात्रा')).toContain('पी');
    expect(decodeSpelledOut('पा चा चमे छोटा की माता सा चरस।')).toContain('चु');
  });

  it('keeps every reading of an ambiguous name ("एक" = आ or ए)', () => {
    const out = decodeSpelledOut('छ छ में एक मात्रा या');
    expect(out).toEqual(expect.arrayContaining(['छा', 'छे']));
  });
});

describe('identifyWrongLetters', () => {
  it('matches identifyCharacterStatus for an ordinary answer', () => {
    const args = { correctAnswer: 'कमल', studentAnswer: 'कलम' };
    expect(identifyWrongLetters(args)).toEqual(
      identifyCharacterStatus(args).incorrectChars,
    );
    expect(
      identifyWrongLetters({ correctAnswer: 'नल', studentAnswer: 'नौ। ~ नो।' }),
    ).toEqual(['ल']);
  });

  it('does not drill a letter the child named correctly in the spelling', () => {
    // पोछा spelled "पा प में ई की मात्रा छ छ में आ की मात्रा पा छ": छ was
    // named right, ो was not (called ई).
    expect(
      identifyWrongLetters({
        correctAnswer: 'पोछा',
        studentAnswer:
          'पा प में ई की मात्रा छ छ में आ की मात्रा पा छ ~ एक की मात्रा छह छह में आठ की मात्रा पांच छह।',
      }),
    ).toEqual(['ो']);
  });

  it('still drills the matra when the child names the wrong one', () => {
    // तोता: "ता तमे उ के माता …" — ो called उ.
    expect(
      identifyWrongLetters({
        correctAnswer: 'तोता',
        studentAnswer: 'ता तमे उ के माता ता तमे एक माता तो ता',
      }),
    ).toEqual(['ो']);
  });

  it('keeps the raw letters when the spelling is entirely right', () => {
    // The child spelled छाया correctly but never blended it: nothing would be
    // left to drill, so the existing behaviour is kept.
    const studentAnswer = 'छ छ में आ की मात्रा य य में आ की मात्रा छ य';
    const out = identifyWrongLetters({ correctAnswer: 'छाया', studentAnswer });
    expect(out.length).toBeGreaterThan(0);
  });
});
