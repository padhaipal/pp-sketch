// Runtime-only redaction of personal details a child may have spoken into a
// voice note. Applied to every viewer, on the way out — the stored transcript
// is never changed and the censored text is never cached. An 80:20 keyword
// pass, not an NER model: it removes
//   • phone-number-like digit runs (6+ digits, spaces/dashes allowed),
//   • the one or two words after a "my name is" phrase in English, Hindi
//     and romanised Hindi,
//   • the names pp-sketch already knows for this conversation (the student,
//     their teacher), as whole words.
// Each removed span becomes REDACTED_MARKER so the reader can see something
// was there.

export const REDACTED_MARKER = '[removed]';

const DIGIT_RUN_RE = /(?<!\d)(?:\d[\s-]?){5,}\d(?!\d)/g;

// "<phrase> <word> [<word>]" — the name follows the phrase; a trailing
// particle like "hai"/"है" is not a name and is left alone.
const NAME_PHRASES = [
  'my name is',
  "my name's",
  'i am',
  'mera naam',
  'mera nam',
  'naam hai',
  'naam',
  'मेरा नाम',
  'नाम है',
  'नाम',
];
const NAME_STOP_WORDS = new Set(['hai', 'he', 'h', 'है', 'hain', 'हैं', 'is']);
const NAME_PHRASE_RE = new RegExp(
  `(${NAME_PHRASES.map(escapeRegExp).join('|')})(\\s+)([^\\s,.!?।]+)(?:(\\s+)([^\\s,.!?।]+))?`,
  'giu',
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word matcher for every known-name token of 3+ characters, longest
// first so "Rani Devi" is removed before "Rani".
function knownNamesRe(
  names: readonly (string | null | undefined)[],
): RegExp | null {
  const tokens = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    const trimmed = name.trim();
    if (trimmed.length >= 3) tokens.add(trimmed);
    for (const part of trimmed.split(/\s+/)) {
      if (part.length >= 3) tokens.add(part);
    }
  }
  if (tokens.size === 0) return null;
  const alternatives = [...tokens]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  // \b is ASCII-only; Devanagari needs explicit non-letter lookarounds.
  return new RegExp(
    `(?<![\\p{L}\\p{M}])(?:${alternatives})(?![\\p{L}\\p{M}])`,
    'giu',
  );
}

export interface CensoredText {
  text: string;
  redactions: number;
}

export function censorTranscript(
  text: string,
  knownNames: readonly (string | null | undefined)[] = [],
): CensoredText {
  let redactions = 0;
  const redact = () => {
    redactions += 1;
    return REDACTED_MARKER;
  };

  let out = text.replace(DIGIT_RUN_RE, redact);

  out = out.replace(
    NAME_PHRASE_RE,
    (
      _m,
      phrase: string,
      gap1: string,
      first: string,
      gap2?: string,
      second?: string,
    ) => {
      if (NAME_STOP_WORDS.has(first.toLowerCase())) return _m;
      redactions += 1;
      const keepSecond = !second || NAME_STOP_WORDS.has(second.toLowerCase());
      return keepSecond
        ? `${phrase}${gap1}${REDACTED_MARKER}${gap2 ?? ''}${second ?? ''}`
        : `${phrase}${gap1}${REDACTED_MARKER}`;
    },
  );

  const names = knownNamesRe(knownNames);
  if (names) out = out.replace(names, redact);

  return { text: out, redactions };
}
