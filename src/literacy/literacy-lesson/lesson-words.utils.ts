// Splits a persisted `word` column value (or a passage's raw text) into its
// component words. Sentences are stored space-joined today, but tolerate
// full paragraph punctuation (danda, double danda, commas, Latin stops,
// quotes, dashes) so a punctuated paragraph still round-trips into clean
// words for recency exclusion, level derivation and the ASER passage
// word-exclusion rule (aser/aser.service.ts).
export function splitLessonWords(stored: string): string[] {
  return stored
    .split(/[\s।॥,.!?;:'"“”‘’()[\]{}\-–—~]+/u)
    .filter((w) => w.length > 0);
}
