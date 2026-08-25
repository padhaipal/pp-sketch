# passage-quality.ts — passage-quality gate

The FIRST gate in the llm-generate pipeline (before passage-judge): scores
the passage TEXT alone — no question, options, or explanations. Same
sequential single-call collection as gate-shared, but with a strict
true/false parser instead of option letters (collectValidRuns is hard-wired
to letters, so the loop lives here).

- Request: one user message — the passage text prepended above the exact
  QUALITY_PROMPT rubric (spelling/grammar, naturalness, readability,
  literary quality or interestingness; score ≥ 4 → true).
- A run is VALID only when the trimmed response is exactly `true` or
  `false`. `True`, `TRUE`, `"true"`, `{true}` and every other variation are
  unparseable, per the rubric's own strictness clause.
- QUALITY_REQUIRED_VALID = 5 valid runs over ≤ QUALITY_MAX_CALLS = 8;
  PASS = ≥ QUALITY_PASS_MIN_TRUE = 3 true votes.
- < 5 valid → 'unverified' (rejected retriable, no DB row — same as the
  other gates).
- The verdict carries `runs`: the raw response of EVERY call in order
  (unparseable verbatim; transport failures as '[call failed: …]' markers),
  plus the usual GateRunStats counters and `true_votes`.

Consumers: createLlmGeneratedMedia (fail → family persisted soft-deleted
with gate_failure {gate:'quality'}, judge/solvability skipped; the passage
row records media_details.quality = {version:1, verdict, true_votes, runs,
counters} on pass AND fail) and the retro sweep
(src/scripts/passage-quality-sweep.ts).
