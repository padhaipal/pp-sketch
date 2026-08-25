# passage-quality-sweep.ts — retroactive quality sweep (CLI)

`npm run passage-quality-sweep [-- --execute]`, run on Railway (needs DB +
Redis + SARVAM_API_KEY env; boots a Nest application context for the
entity services).

Targets every LIVE passage (media_type='text', role='passage',
status='ready', rolled_back=false).

- `--report` (default): STRICTLY READ-ONLY on the DB — the pure
  `sweepPassageQuality` issues only SELECTs and never touches
  recordPassageQuality/markRolledBack (pinned by spec). LLM judging still
  runs for passages without a stored verdict; the timestamped JSON report
  file is the only record of those runs. Output: would-fail passages with
  the exact live provenance subtree markRolledBack would flip (recursive
  over input_media_id, rolled_back=false), post-deletion live counts per
  passage_type × level (computed in memory), and unverified passages
  (listed, never counted as deletions).
- `--execute`: reuse a stored version-1 pass/fail verdict (resumability;
  stored 'unverified' is re-judged), ALWAYS write media_details.quality via
  MediaMetaDataService.recordPassageQuality, soft-delete failing families
  via the existing markRolledBack(passageId), then print the same stats
  from actual DB state.

Core logic is the exported pure `sweepPassageQuality(deps, mode,
generatedAt)` — DB, LLM, and service writes are injected, so the spec runs
offline. The Nest CLI bootstrap lives in the separate
`passage-quality-sweep.main.ts` (istanbul-ignored) so importing the sweep
module never loads AppModule.
