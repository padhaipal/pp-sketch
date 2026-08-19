/**
 * Word-level Needleman–Wunsch sentence assessment.
 *
 * Replaces the old subsequence-walk `markSentence`: each STT transcript is
 * globally aligned against the target words (target words × transcript
 * tokens), per-word verdicts are fused across engines (a word counts correct
 * if ANY engine heard it correctly), and the pass/fail decision counts
 * substitutions + omissions + one error per transposed pair against a 10%
 * error budget. The same per-word
 * evidence drives drill-word selection, so pass/fail and remediation can
 * never disagree about what went wrong.
 *
 * Deterministic: no LLM calls, no randomness except the documented tie-break
 * in `selectDrillWord`.
 */
import {
  cleanWord,
  levenshteinDistance,
  markWord,
  TEACHABLE_GRAPHEMES,
  tokenizeUtterance,
} from './evaluate-answer.utils';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Max misread share to pass. GPF Reading (UIS et al., Oct 2020), D2.1.1_M,
 * Grade 2: "no more than 10 percent of the words." Table 4 p. 18.
 * https://tcg.uis.unesco.org/wp-content/uploads/sites/4/2020/10/WG-GAML-4-reading-4.1.1-Global-proficiency-framework.pdf
 * Illustrative ("e.g."), grade-2-only; applying to levels 9-12 is our
 * extension, pending calibration.
 */
export const READ_ERROR_BUDGET_RATIO = 0.1;
/** Floor of one error: at level 8 (<10 words) a bare 10% rounds to zero tolerance. */
export const READ_ERROR_BUDGET_MIN = 1;

/** Akshara distance at or below which a word is a 'close' read, not an error. */
export const AKSHARA_CLOSE_DISTANCE = 1;

/** Alignment cost of an exact/equivalent word match. */
export const COST_MATCH = 0;
/** Alignment cost of a close read (akshara distance 1). */
export const COST_CLOSE = 0.5;
/** Alignment cost of a substitution (akshara distance ≥ 2). */
export const COST_SUBSTITUTION = 1.0;
/** Alignment cost of a gap — an omitted target word or a (non-free) inserted token. */
export const COST_GAP = 1.0;

// Filler noises the STT engines transcribe; inserting one is normal speech,
// never penalized in the alignment. Compared in normalized form.
const RAW_DISFLUENCY_TOKENS = [
  'उम्म',
  'उम',
  'अं',
  'आं',
  'एं',
  'ऊं',
  'हं',
  'हूँ',
  'हाँ',
  'ओह',
  'उह',
  'um',
  'uh',
  'hmm',
];

// ─── Types ───────────────────────────────────────────────────────────────────

export type SentenceWordStatus =
  | 'correct'
  | 'close'
  | 'substituted'
  | 'omitted'
  | 'transposed';

export interface SentenceAssessment {
  passed: boolean;
  wordCount: number;
  errorCount: number; // substitutions + omissions + one per transposed pair; insertions excluded
  accuracy: number;
  words: Array<{
    target: string;
    heard: string | null;
    status: SentenceWordStatus;
    aksharaDistance: number;
    teachable: boolean; // every codepoint in TEACHABLE_GRAPHEMES
  }>;
}

export type SentenceArgs = { words: string[]; transcripts: string[] };

type WordResult = SentenceAssessment['words'][number];

// ─── Normalization (shared by target and transcript sides) ───────────────────

const normalizeCache = new Map<string, string>();

/**
 * Canonical form for comparison: cleanWord (NFC, strip everything that is not
 * a letter/mark/digit — which also removes ZWJ/ZWNJ format characters —
 * lowercase), then zero-cost orthographic equivalences (variants, not
 * errors): optional nukta dropped (ज़→ज), chandrabindu → anusvara (हँसी→हंसी),
 * conjunct nasal → anusvara (हिन्दी→हिंदी). The surface form is kept alongside
 * so verdicts can quote what the child actually said.
 */
export function normalizeForAlignment(raw: string): string {
  const cached = normalizeCache.get(raw);
  if (cached !== undefined) return cached;
  const normalized = cleanWord(raw)
    .normalize('NFD')
    .replace(/़/g, '') // nukta
    .normalize('NFC')
    .replace(/ँ/g, 'ं') // chandrabindu → anusvara
    .replace(/[नमणङञ]्(?=[क-ह])/g, 'ं'); // conjunct nasal → anusvara
  normalizeCache.set(raw, normalized);
  return normalized;
}

const DISFLUENCY_TOKENS: ReadonlySet<string> = new Set(
  RAW_DISFLUENCY_TOKENS.map(normalizeForAlignment),
);

// ─── Akshara distance ────────────────────────────────────────────────────────

// Devanagari grapheme clusters ("akshara"), NOT code units: क्या is one
// cluster, so क्या vs कया scores 2 (delete cluster + insert two), not 1.
const segmenter = new Intl.Segmenter('hi', { granularity: 'grapheme' });

const clusterCache = new Map<string, string[]>();

function clustersOf(normalized: string): string[] {
  const cached = clusterCache.get(normalized);
  if (cached !== undefined) return cached;
  const clusters = [...segmenter.segment(normalized)].map((s) => s.segment);
  clusterCache.set(normalized, clusters);
  return clusters;
}

// Passages repeat words heavily — memoize word-pair distances.
const distanceCache = new Map<string, number>();

// Cache-key separator: U+001F (unit separator). A Cc control character, so
// cleanWord's [^\p{L}\p{M}\p{N}] strip guarantees it can never appear in a
// normalized word — two distinct word pairs can never collide on a key
// ("अब"+"कद" vs "अबक"+"द" naively concatenate identically).
const CACHE_KEY_SEPARATOR = '\u001f';

/** Levenshtein over grapheme clusters of the normalized words. */
export function aksharaDistance(a: string, b: string): number {
  const na = normalizeForAlignment(a);
  const nb = normalizeForAlignment(b);
  const key = `${na}${CACHE_KEY_SEPARATOR}${nb}`;
  const cached = distanceCache.get(key);
  if (cached !== undefined) return cached;
  const distance = levenshteinDistance(clustersOf(na), clustersOf(nb));
  distanceCache.set(key, distance);
  return distance;
}

// ─── Alignment ───────────────────────────────────────────────────────────────

const matchCostCache = new Map<string, number>();

// Substitution cost of reading `token` where `target` was expected. 0 when
// equal after normalization OR when word-lesson acceptance (markWord: phoneme
// families, ASR hardcodes, numerals, schwa deletion) says the token IS the
// word — this keeps sentence marking consistent with word-lesson marking.
function matchCost(target: string, token: string): number {
  const key = `${target}${CACHE_KEY_SEPARATOR}${token}`;
  const cached = matchCostCache.get(key);
  if (cached !== undefined) return cached;
  let cost: number;
  if (
    normalizeForAlignment(target) === normalizeForAlignment(token) ||
    markWord({ correctAnswer: target, studentAnswer: token })
  ) {
    cost = COST_MATCH;
  } else if (aksharaDistance(target, token) <= AKSHARA_CLOSE_DISTANCE) {
    cost = COST_CLOSE;
  } else {
    cost = COST_SUBSTITUTION;
  }
  matchCostCache.set(key, cost);
  return cost;
}

// Free insertions: disfluency fillers, and a token repeating the immediately
// preceding target word — self-correction is normal reading and must never be
// penalized.
function insertionCost(token: string, prevTarget: string | undefined): number {
  if (DISFLUENCY_TOKENS.has(normalizeForAlignment(token))) return 0;
  if (prevTarget !== undefined && matchCost(prevTarget, token) === COST_MATCH) {
    return 0;
  }
  return COST_GAP;
}

// Global Needleman–Wunsch of target words × one transcript's tokens.
// O(N×M) — fine at N≈150. Traceback tie-break is deterministic:
// match/substitute > insert > omit.
function alignTranscript(targets: string[], tokens: string[]): WordResult[] {
  const n = targets.length;
  const m = tokens.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) dp[i][0] = dp[i - 1][0] + COST_GAP;
  for (let j = 1; j <= m; j++) {
    dp[0][j] = dp[0][j - 1] + insertionCost(tokens[j - 1], undefined);
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j - 1] + matchCost(targets[i - 1], tokens[j - 1]),
        dp[i][j - 1] + insertionCost(tokens[j - 1], targets[i - 1]),
        dp[i - 1][j] + COST_GAP,
      );
    }
  }

  // Traceback.
  const results: WordResult[] = new Array<WordResult>(n);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      dp[i][j] === dp[i - 1][j - 1] + matchCost(targets[i - 1], tokens[j - 1])
    ) {
      const target = targets[i - 1];
      const heard = tokens[j - 1];
      const cost = matchCost(target, heard);
      results[i - 1] = {
        target,
        heard,
        status:
          cost === COST_MATCH
            ? 'correct'
            : cost === COST_CLOSE
              ? 'close'
              : 'substituted',
        aksharaDistance:
          cost === COST_MATCH ? 0 : aksharaDistance(target, heard),
        teachable: isTeachable(target),
      };
      i--;
      j--;
    } else if (
      j > 0 &&
      dp[i][j] ===
        dp[i][j - 1] +
          insertionCost(tokens[j - 1], i > 0 ? targets[i - 1] : undefined)
    ) {
      j--; // inserted token — recorded nowhere, insertions are not errors
    } else {
      const target = targets[i - 1];
      results[i - 1] = {
        target,
        heard: null,
        status: 'omitted',
        // An omitted word costs its whole length, mirroring the old
        // assessment's convention — keeps drill ranking meaningful.
        aksharaDistance: clustersOf(normalizeForAlignment(target)).length,
        teachable: isTeachable(target),
      };
      i--;
    }
  }

  markTranspositions(targets, results);
  return results;
}

// Post-pass: an adjacent swap of two target words is a transposition, not two
// substitutions — both words were read, just out of order.
function markTranspositions(targets: string[], results: WordResult[]): void {
  for (let i = 0; i + 1 < results.length; i++) {
    const a = results[i];
    const b = results[i + 1];
    if (
      (a.status === 'substituted' || a.status === 'close') &&
      (b.status === 'substituted' || b.status === 'close') &&
      a.heard !== null &&
      b.heard !== null &&
      matchCost(targets[i], b.heard) === COST_MATCH &&
      matchCost(targets[i + 1], a.heard) === COST_MATCH
    ) {
      a.status = 'transposed';
      a.aksharaDistance = 0;
      b.status = 'transposed';
      b.aksharaDistance = 0;
      i++; // the pair is consumed
    }
  }
}

function isTeachable(word: string): boolean {
  return Array.from(word.normalize('NFC')).every((ch) =>
    TEACHABLE_GRAPHEMES.has(ch),
  );
}

// Fusion order: a word takes its best status across engines.
const STATUS_RANK: Record<SentenceWordStatus, number> = {
  correct: 0,
  close: 1,
  transposed: 2,
  substituted: 3,
  omitted: 4,
};

/** Number of word errors allowed for a passing read of `wordCount` words. */
export function readErrorBudget(wordCount: number): number {
  return Math.max(
    READ_ERROR_BUDGET_MIN,
    Math.ceil(READ_ERROR_BUDGET_RATIO * wordCount),
  );
}

/**
 * Assess a sentence read against every STT transcript. Each transcript is
 * aligned INDEPENDENTLY (each additionally split at the '~' engine-join
 * token, since the fallback path hands us the combined string), then fused
 * per word: a word counts correct if any engine heard it correctly. Per-word
 * fusion cancels engine noise; per-passage best-of would let one lucky
 * transcript mask a real error.
 *
 * Decision rule: substitutions + omissions, plus ONE error per transposed
 * pair — a transposition is a decoding error, but a single one, so the pair
 * counts once, not per word. Insertions are excluded (in read-aloud they are
 * mostly disfluency); 'close' does not count.
 */
export function assessSentence({
  words,
  transcripts,
}: SentenceArgs): SentenceAssessment {
  if (words.length === 0) {
    console.error('assessSentence: words is empty');
    return {
      passed: false,
      wordCount: 0,
      errorCount: 0,
      accuracy: 0,
      words: [],
    };
  }

  const segments = transcripts
    .flatMap((t) => t.split('~'))
    .map((s) => tokenizeUtterance(s))
    .filter((tokens) => tokens.length > 0);

  const alignments =
    segments.length > 0
      ? segments.map((tokens) => alignTranscript(words, tokens))
      : [alignTranscript(words, [])];

  const fused: WordResult[] = words.map((_, wi) => {
    let best = alignments[0][wi];
    for (let ai = 1; ai < alignments.length; ai++) {
      const candidate = alignments[ai][wi];
      if (STATUS_RANK[candidate.status] < STATUS_RANK[best.status]) {
        best = candidate;
      }
    }
    return best;
  });

  const substitutionAndOmissionCount = fused.filter(
    (w) => w.status === 'substituted' || w.status === 'omitted',
  ).length;
  // One error per transposed PAIR. Within one alignment transposed words
  // always come in adjacent pairs, so a run of 2k fused 'transposed' words is
  // k pairs; the ceil covers a singleton left over when fusion upgraded its
  // pair-mate to 'correct' via another engine (still one decoding error).
  let transpositionErrors = 0;
  let transposedRun = 0;
  for (const w of fused) {
    if (w.status === 'transposed') {
      transposedRun++;
    } else {
      transpositionErrors += Math.ceil(transposedRun / 2);
      transposedRun = 0;
    }
  }
  transpositionErrors += Math.ceil(transposedRun / 2);

  const errorCount = substitutionAndOmissionCount + transpositionErrors;
  const wordCount = words.length;
  return {
    passed: errorCount <= readErrorBudget(wordCount),
    wordCount,
    errorCount,
    accuracy: (wordCount - errorCount) / wordCount,
    words: fused,
  };
}

/**
 * Drill-word selection from the SAME per-word evidence that produced the
 * verdict: among substituted/omitted teachable words, the highest
 * aksharaDistance, random on ties (the only nondeterminism in this module).
 * Null when no teachable word qualifies — the caller falls through to a
 * sentence retry.
 */
export function selectDrillWord(
  words: SentenceAssessment['words'],
): string | null {
  const candidates = words.filter(
    (w) =>
      (w.status === 'substituted' || w.status === 'omitted') && w.teachable,
  );
  if (candidates.length === 0) return null;
  const maxDistance = Math.max(...candidates.map((w) => w.aksharaDistance));
  const worst = candidates.filter((w) => w.aksharaDistance === maxDistance);
  return worst[Math.floor(Math.random() * worst.length)].target;
}
