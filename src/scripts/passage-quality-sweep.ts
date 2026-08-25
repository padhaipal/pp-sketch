/**
 * Retroactive passage-quality sweep over every LIVE passage
 * (media_type='text', role='passage', status='ready', rolled_back=false).
 *
 *   npm run passage-quality-sweep            # --report (default)
 *   npm run passage-quality-sweep -- --execute
 *
 * --report is STRICTLY READ-ONLY on the database (LLM calls still happen
 * for unjudged passages; the timestamped JSON report file is the only
 * record of those runs). It prints + writes: (a) every passage that WOULD
 * fail, with the full entity set the soft delete would flip — the passage
 * plus its live provenance-descendant subtree exactly as markRolledBack's
 * recursive flag computes it; (b) post-deletion live-passage counts per
 * passage_type × level; (c) unverified passages (listed, never counted as
 * deletions).
 *
 * --execute reuses a stored version-1 pass/fail verdict (resumability) or
 * judges the passage, ALWAYS writes media_details.quality back onto the
 * passage row (via MediaMetaDataService.recordPassageQuality — this is
 * what the dashboard displays), and soft-deletes failing families via the
 * existing markRolledBack(passageId). Stored 'unverified' verdicts are
 * re-judged — unverified is the absence of a verdict, not one to cache.
 */
import {
  PassageQualityVerdict,
  QUALITY_REQUIRED_VALID,
} from '../media-meta-data/passage-quality';

export interface SweepPassageRow {
  id: string;
  text: string;
  level: number | null;
  passage_type: string | null;
  quality: Record<string, unknown> | null;
}

export interface SweptEntity {
  id: string;
  media_type: string;
  role: string | null;
}

export interface SweepDeps {
  /** Raw SQL reads only — the sweep itself never writes through this. */
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  /** Judges one passage text (LLM); injected so tests stay offline. */
  judgePassage: (text: string) => Promise<PassageQualityVerdict>;
  /** Entity-service writes — used in --execute only. */
  recordPassageQuality: (
    passageId: string,
    quality: Record<string, unknown>,
  ) => Promise<void>;
  markRolledBack: (mediaId: string) => Promise<void>;
  log: (message: string) => void;
}

export interface SweepReport {
  mode: 'report' | 'execute';
  generated_at: string;
  live_passages: number;
  reused_verdicts: number;
  judged_now: number;
  failing: Array<{
    passage_id: string;
    level: number | null;
    passage_type: string | null;
    true_votes: number | null;
    text: string;
    runs: string[];
    entities: SweptEntity[];
  }>;
  unverified: Array<{
    passage_id: string;
    level: number | null;
    passage_type: string | null;
    runs: string[];
  }>;
  remaining_live_counts: Array<{
    passage_type: string | null;
    level: number | null;
    passages: number;
  }>;
}

interface StoredQuality {
  version?: unknown;
  verdict?: unknown;
  true_votes?: unknown;
  runs?: unknown;
}

// Reusable = a version-1 pass/fail verdict; 'unverified' is re-judged.
function reusableVerdict(quality: Record<string, unknown> | null): {
  verdict: 'pass' | 'fail';
  true_votes: number | null;
  runs: string[];
} | null {
  const q = quality as StoredQuality | null;
  if (!q || q.version !== 1) return null;
  if (q.verdict !== 'pass' && q.verdict !== 'fail') return null;
  return {
    verdict: q.verdict,
    true_votes: typeof q.true_votes === 'number' ? q.true_votes : null,
    runs: Array.isArray(q.runs) ? (q.runs as string[]) : [],
  };
}

export function qualityRecordOf(
  verdict: PassageQualityVerdict,
): Record<string, unknown> {
  return {
    version: 1,
    verdict:
      verdict.status === 'passed'
        ? 'pass'
        : verdict.status === 'failed_quality'
          ? 'fail'
          : 'unverified',
    ...(verdict.true_votes !== undefined && { true_votes: verdict.true_votes }),
    runs: verdict.runs,
    valid_runs: verdict.valid_runs,
    total_calls: verdict.total_calls,
    call_failures: verdict.call_failures,
    unparseable: verdict.unparseable,
  };
}

// Read-only mirror of markRolledBack's recursive descendant flag: the
// passage row plus every LIVE row reachable over input_media_id — exactly
// the set the soft delete would flip.
async function subtreeOf(
  deps: SweepDeps,
  passageId: string,
): Promise<SweptEntity[]> {
  const rows = (await deps.query(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM media_metadata WHERE id = $1
       UNION ALL
       SELECT m.id FROM media_metadata m
       JOIN subtree s ON m.input_media_id = s.id
     )
     SELECT m.id, m.media_type, m.media_details->>'role' AS role
     FROM media_metadata m
     JOIN subtree s ON s.id = m.id
     WHERE m.rolled_back = false
     ORDER BY m.created_at ASC`,
    [passageId],
  )) as SweptEntity[];
  return rows;
}

async function livePassageCounts(
  deps: SweepDeps,
): Promise<SweepReport['remaining_live_counts']> {
  const rows = (await deps.query(
    `SELECT media_details->>'passage_type' AS passage_type,
            (media_details->>'level')::int AS level,
            COUNT(*)::int AS passages
     FROM media_metadata
     WHERE media_type = 'text' AND status = 'ready' AND rolled_back = false
       AND media_details->>'role' = 'passage'
     GROUP BY 1, 2 ORDER BY 1, 2`,
  )) as SweepReport['remaining_live_counts'];
  return rows.map((r) => ({ ...r, passages: Number(r.passages) }));
}

export async function sweepPassageQuality(
  deps: SweepDeps,
  mode: 'report' | 'execute',
  generatedAt: string,
): Promise<SweepReport> {
  const passages = (await deps.query(
    `SELECT id, text,
            (media_details->>'level')::int   AS level,
            media_details->>'passage_type'   AS passage_type,
            media_details->'quality'         AS quality
     FROM media_metadata
     WHERE media_type = 'text' AND status = 'ready' AND rolled_back = false
       AND media_details->>'role' = 'passage'
     ORDER BY created_at ASC`,
  )) as SweepPassageRow[];

  const report: SweepReport = {
    mode,
    generated_at: generatedAt,
    live_passages: passages.length,
    reused_verdicts: 0,
    judged_now: 0,
    failing: [],
    unverified: [],
    remaining_live_counts: [],
  };

  for (const passage of passages) {
    const reused = reusableVerdict(passage.quality);
    let verdict: 'pass' | 'fail' | 'unverified';
    let trueVotes: number | null;
    let runs: string[];
    if (reused) {
      report.reused_verdicts++;
      verdict = reused.verdict;
      trueVotes = reused.true_votes;
      runs = reused.runs;
    } else {
      const judged = await deps.judgePassage(passage.text);
      report.judged_now++;
      const record = qualityRecordOf(judged);
      verdict = record.verdict as 'pass' | 'fail' | 'unverified';
      trueVotes = judged.true_votes !== undefined ? judged.true_votes : null;
      runs = judged.runs;
      if (mode === 'execute') {
        await deps.recordPassageQuality(passage.id, record);
      }
    }
    deps.log(
      `${passage.id} level=${String(passage.level)} ${String(passage.passage_type)} → ${verdict}` +
        (trueVotes !== null
          ? ` (${trueVotes}/${QUALITY_REQUIRED_VALID} true)`
          : ''),
    );

    if (verdict === 'unverified') {
      report.unverified.push({
        passage_id: passage.id,
        level: passage.level,
        passage_type: passage.passage_type,
        runs,
      });
    } else if (verdict === 'fail') {
      report.failing.push({
        passage_id: passage.id,
        level: passage.level,
        passage_type: passage.passage_type,
        true_votes: trueVotes,
        text: passage.text,
        entities: await subtreeOf(deps, passage.id),
        runs,
      });
      if (mode === 'execute') {
        await deps.markRolledBack(passage.id);
      }
    }
  }

  if (mode === 'execute') {
    // Actual DB state, post-deletions.
    report.remaining_live_counts = await livePassageCounts(deps);
  } else {
    // What WOULD remain: live counts minus the would-fail set, computed in
    // memory — report mode never writes.
    const failingIds = new Set(report.failing.map((f) => f.passage_id));
    const counts = new Map<string, number>();
    for (const p of passages) {
      if (failingIds.has(p.id)) continue;
      const key = `${String(p.passage_type)}|${String(p.level)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    report.remaining_live_counts = Array.from(counts.entries())
      .map(([key, passages_]) => {
        const [passageType, level] = key.split('|');
        return {
          passage_type: passageType === 'null' ? null : passageType,
          level: level === 'null' ? null : Number(level),
          passages: passages_,
        };
      })
      .sort(
        (a, b) =>
          String(a.passage_type).localeCompare(String(b.passage_type)) ||
          Number(a.level) - Number(b.level),
      );
  }

  return report;
}
