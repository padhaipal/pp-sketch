import { identifyCharacterStatus } from './identify-character-status.utils';

/*
 * Spelled-out ("barahkhadi") answers.
 *
 * Many children read a word the way classrooms teach the barahkhadi, naming
 * each consonant and its matra before (sometimes) blending:
 *
 *   डाक  → "ड में आ की मात्रा डा, क"
 *   छाया → "छ छ में आ की मात्रा य य में आ की मात्रा छ य"
 *
 * In the 20 Oct 2026 log, 16 children answered word cards this way (264
 * replies). markWord rightly does not accept these (the child has not read
 * the word as a word). But identifyCharacterStatus picks the letters to drill
 * from the raw transcript, where the filler words ("में", "की", "मात्रा") and
 * half-heard syllables can make letters the child named correctly look wrong,
 * so the letter loop drilled those instead of the ones the child got wrong.
 *
 * decodeSpelledOut() turns such an answer into the word(s) the child spelled;
 * identifyWrongLetters() uses those to choose which letters to drill.
 */

// The vowel named before "की मात्रा" → the matra(s) it can mean. Most names
// are unambiguous; a few transcriptions could be more than one, and every
// reading is kept as a candidate (the caller picks the closest to the word).
const VOWEL_TO_MATRAS: Record<string, string[]> = {
  आ: ['ा'],
  इ: ['ि'],
  ई: ['ी'],
  उ: ['ु'],
  ऊ: ['ू'],
  ऋ: ['ृ'],
  ए: ['े'],
  ऐ: ['ै'],
  ओ: ['ो'],
  औ: ['ौ'],
  // Hard coding: "आ की" / "ए की" are both heard as "एक (की)".
  एक: ['ा', 'े'],
  // "बड़े / बड़ा की मात्रा" with no vowel: the long ा, ी or ू.
  बड़े: ['ा', 'ी', 'ू'],
  बड़ा: ['ा', 'ी', 'ू'],
  // Hard coding: "आ की मात्रा" heard as "आँख / आग की मात्रा".
  आँख: ['ा'],
  आग: ['ा'],
};

const CONSONANTS = new Set('कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह'.split(''));

// "<consonant> में <vowel> की मात्रा" — the joining word as the engines hear it.
const IN_WORDS = new Set(['में', 'मैं', 'मे', 'मै', 'पर', 'पे']);
const OF_WORDS = new Set(['की', 'के', 'कि', 'का']);
// मात्रा as heard: मात्रा, मात्र, मात्राएं, मातरा, माता, माथे.
const isMatraWord = (t: string) =>
  t.startsWith('मात्र') || t === 'मातरा' || t === 'माता' || t === 'माथे';

// Hard coding: how the speech engines hear the matra names, and the
// classroom names for the short/long pairs, rewritten to "<vowel> की मात्रा".
// Taken from transcripts in the 20 Oct 2026 log. Applied in order.
const MATRA = '(?:मात्र\\S*|माता|मातरा|माथे)';
const PHRASE_FIXES: [RegExp, string][] = [
  // "में आ की" run together: "मैक / मेक / मेंक मात्रा".
  [/(?:मैक|मेक|मेंक)(?=\s)/gu, 'में एक'],
  [new RegExp(`ओके\\s*${MATRA}`, 'gu'), 'ओ की मात्रा'], // "ओ की" heard as "ओके"
  [new RegExp(`ओकी\\s*${MATRA}`, 'gu'), 'ओ की मात्रा'],
  [new RegExp(`(?:आपकी|आके|आकी)\\s*${MATRA}`, 'gu'), 'आ की मात्रा'],
  [new RegExp(`एकी\\s*${MATRA}`, 'gu'), 'एक की मात्रा'],
  [new RegExp(`(?:आई\\s*की|आईक|ईकी)\\s*${MATRA}`, 'gu'), 'ई की मात्रा'],
  [new RegExp(`ऊके\\s*${MATRA}`, 'gu'), 'ऊ की मात्रा'],
  [/(?:बड़े|बड़ा)\s*आ(?=\s)/gu, 'आ'], // "बड़े आ की मात्रा" = ा
  // Classroom names: ि is "छोटी इ", ी "बड़ी ई", ु "छोटा उ", ू "बड़ा ऊ".
  [
    new RegExp(`छोटी\\s*(?:इ|ई)?\\s*(?:की|के)?\\s*${MATRA}`, 'gu'),
    'इ की मात्रा',
  ],
  [
    new RegExp(`बड़ी\\s*(?:ई|इ|एक)?\\s*(?:की|के)?\\s*${MATRA}`, 'gu'),
    'ई की मात्रा',
  ],
  [
    new RegExp(
      `(?:छोटा|छोटे|छुटा)\\s*(?:उ|ऊ)?\\s*(?:की|के)?\\s*${MATRA}`,
      'gu',
    ),
    'उ की मात्रा',
  ],
  [
    new RegExp(`(?:बड़ा|बड़े)\\s*ऊ\\s*(?:की|के)?\\s*${MATRA}`, 'gu'),
    'ऊ की मात्रा',
  ],
];

const tokens = (s: string): string[] =>
  s
    .normalize('NFC')
    .split(/[\s।॥,.!?;:'"“”‘’()[\]{}\-–—~]+/u)
    .filter((t) => t.length > 0)
    // "गामे" / "चमे": the base syllable run together with "में".
    .flatMap((t) => {
      const m = /^(.+?)(में|मे)$/u.exec(t);
      return m && firstConsonant(m[1]) ? [m[1], 'में'] : [t];
    });

function firstConsonant(t: string): string | undefined {
  return Array.from(t).find((ch) => CONSONANTS.has(ch));
}

const isBareConsonant = (t: string) =>
  Array.from(t).length === 1 && CONSONANTS.has(t);

type Unit = { syllables: string[]; tail: string };

// One transcript (no "~" joins) → the syllables it spells, in order, each with
// any bare consonants the child said after it ("डा, क" → { डा, क }).
const decodeSegment = (segment: string): Unit[] => {
  let text = ` ${segment.normalize('NFC')} `;
  for (const [re, to] of PHRASE_FIXES) text = text.replace(re, to);
  const t = tokens(text);

  const units: { start: number; end: number; syllables: string[] }[] = [];
  for (let k = 1; k + 2 < t.length; k++) {
    if (!IN_WORDS.has(t[k])) continue;
    const matras = VOWEL_TO_MATRAS[t[k + 1]];
    if (!matras) continue;
    let m = k + 2;
    if (OF_WORDS.has(t[m])) m++;
    if (m >= t.length || !isMatraWord(t[m])) continue;
    const base = firstConsonant(t[k - 1]);
    if (!base) continue;
    // The base is often repeated before "में" ("छ छ में …"): absorb repeats.
    let start = k - 1;
    while (start > 0 && firstConsonant(t[start - 1]) === base) start--;
    units.push({ start, end: m, syllables: matras.map((x) => base + x) });
    k = m;
  }

  return units.map((u, i) => {
    const stop = i + 1 < units.length ? units[i + 1].start : t.length;
    const tail = t
      .slice(u.end + 1, stop)
      .filter(isBareConsonant)
      .join('');
    return { syllables: u.syllables, tail };
  });
};

// Every way of reading a run of units (each unit may have several syllables).
const spellings = (run: Unit[], withTails: boolean): string[] =>
  run.reduce<string[]>(
    (acc, u) =>
      acc.flatMap((prefix) =>
        u.syllables.map((s) => prefix + s + (withTails ? u.tail : '')),
      ),
    [''],
  );

/**
 * Candidate words a spelled-out answer spells. Empty when the answer has no
 * "<consonant> में <vowel> की मात्रा" phrase. Candidates are every contiguous
 * run (up to 4) of the decoded syllables, with and without the bare
 * consonants said after each one, so the caller can pick the closest to the
 * target word.
 */
export const decodeSpelledOut = (studentAnswer: string): string[] => {
  const out = new Set<string>();
  for (const segment of studentAnswer.split('~')) {
    const units = decodeSegment(segment);
    for (let i = 0; i < units.length; i++) {
      for (let j = i; j < Math.min(units.length, i + 4); j++) {
        const run = units.slice(i, j + 1);
        for (const s of spellings(run, false)) out.add(s);
        for (const s of spellings(run, true)) out.add(s);
      }
    }
  }
  return [...out];
};

/**
 * The letters of `correctAnswer` to drill after a wrong word answer.
 *
 * Normally these are the letters identifyCharacterStatus finds wrong in the
 * raw transcript. For a spelled-out answer, letters the child named correctly
 * in the spelling (per the closest decoded candidate) are taken off that list:
 * this only ever removes letters, never adds them.
 *
 * If that would leave nothing to drill — the child named every letter right
 * but did not blend the word — the raw list is kept so the letter loop still
 * has a letter to start on. How to treat that case (e.g. a "now say it
 * together" prompt instead of the letter loop) is a separate decision.
 */
export const identifyWrongLetters = ({
  correctAnswer,
  studentAnswer,
}: {
  correctAnswer: string;
  studentAnswer: string;
}): string[] => {
  const raw = identifyCharacterStatus({
    correctAnswer,
    studentAnswer,
  }).incorrectChars;
  const decoded = decodeSpelledOut(studentAnswer);
  if (decoded.length === 0) return raw;
  const namedRight = new Set(
    identifyCharacterStatus({
      correctAnswer,
      studentAnswer: decoded.join(' '),
    }).correctChars,
  );
  const remaining = raw.filter((ch) => !namedRight.has(ch));
  return remaining.length > 0 ? remaining : raw;
};
