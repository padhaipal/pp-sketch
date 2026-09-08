/**
 * One-off soft-delete of every LIVE reading passage whose text contains a
 * digit (ASCII 0-9 or Devanagari ०-९) — digits are ambiguous to read aloud,
 * and newly generated passages are now rejected for them at the DTO gate
 * (PASSAGE_DIGITS_RE in llm-generate.dto.ts).
 *
 *   npm run purge-digit-passages               # preview (default, read-only)
 *   npm run purge-digit-passages -- --execute  # soft-delete via markRolledBack
 *
 * Soft delete only: markRolledBack flips rolled_back=true on the passage and
 * its whole provenance subtree (question, options, explanations, explanation
 * audio, flow) and busts the media caches. Nothing is physically removed —
 * NIPUN g2/g3 and MPL-B history deliberately keeps counting rolled-back
 * passages until answers age out of the scoring window. Re-runs are
 * idempotent (only rolled_back=false passages are selected).
 */
import { PASSAGE_DIGITS_RE } from '../media-meta-data/llm-generate.dto';

export interface PurgePassageRow {
  id: string;
  text: string;
  level: number | null;
  passage_type: string | null;
}

export interface PurgeFamilyEntity {
  id: string;
  media_type: string;
  role: string | null;
}

export interface PurgeDeps {
  /** Raw SQL reads only — the purge itself never writes through this. */
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  /** Entity-service soft delete — used in --execute only. */
  markRolledBack: (mediaId: string) => Promise<void>;
  log: (message: string) => void;
}

export interface PurgeReport {
  mode: 'preview' | 'execute';
  passages: Array<{
    passage_id: string;
    level: number | null;
    passage_type: string | null;
    text_preview: string;
    entities: PurgeFamilyEntity[];
    outcome: 'previewed' | 'rolled_back' | 'failed';
    error?: string;
  }>;
  total_passages: number;
  total_entities: number;
  failed: number;
}

const PREVIEW_CHARS = 80;

export async function purgeDigitPassages(
  deps: PurgeDeps,
  mode: 'preview' | 'execute',
): Promise<PurgeReport> {
  const rows = (await deps.query(
    `SELECT id, text, (media_details->>'level')::int AS level,
            media_details->>'passage_type' AS passage_type
     FROM media_metadata
     WHERE media_type = 'text'
       AND media_details->>'role' = 'passage'
       AND rolled_back = false
       AND text ~ '[0-9\u0966-\u096F]'
     ORDER BY created_at ASC`,
  )) as PurgePassageRow[];

  const report: PurgeReport = {
    mode,
    passages: [],
    total_passages: rows.length,
    total_entities: 0,
    failed: 0,
  };
  deps.log(
    `${mode}: ${rows.length} live digit-bearing passage(s)` +
      (mode === 'preview' ? ' — no writes will happen' : ''),
  );

  for (const row of rows) {
    // sanity: SQL and DTO regexes must agree
    if (!PASSAGE_DIGITS_RE.test(row.text)) continue;
    // The live provenance subtree markRolledBack would flip (same FK walk).
    const entities = (await deps.query(
      `WITH RECURSIVE fam AS (
         SELECT id, media_type, media_details->>'role' AS role
         FROM media_metadata WHERE id = $1
         UNION ALL
         SELECT m.id, m.media_type, m.media_details->>'role' AS role
         FROM media_metadata m JOIN fam f ON m.input_media_id = f.id
         WHERE m.rolled_back = false
       )
       SELECT id, media_type, role FROM fam`,
      [row.id],
    )) as PurgeFamilyEntity[];

    const byType = new Map<string, number>();
    for (const e of entities) {
      const key = e.role ? `${e.media_type}/${e.role}` : e.media_type;
      byType.set(key, (byType.get(key) ?? 0) + 1);
    }
    const breakdown = [...byType.entries()]
      .map(([k, n]) => `${n}× ${k}`)
      .join(', ');
    const preview =
      row.text.length > PREVIEW_CHARS
        ? row.text.slice(0, PREVIEW_CHARS) + '…'
        : row.text;

    let outcome: 'previewed' | 'rolled_back' | 'failed' = 'previewed';
    let error: string | undefined;
    if (mode === 'execute') {
      try {
        await deps.markRolledBack(row.id);
        outcome = 'rolled_back';
      } catch (err) {
        outcome = 'failed';
        error = err instanceof Error ? err.message : String(err);
        report.failed += 1;
      }
    }
    deps.log(
      `${outcome}: ${row.id} (level ${row.level ?? '?'}, ${row.passage_type ?? '?'}) ` +
        `"${preview}" → ${entities.length} rows [${breakdown}]` +
        (error ? ` — ${error}` : ''),
    );
    report.total_entities += entities.length;
    report.passages.push({
      passage_id: row.id,
      level: row.level,
      passage_type: row.passage_type,
      text_preview: preview,
      entities,
      outcome,
      error,
    });
  }

  deps.log(
    `${mode} done: ${report.total_passages} passage(s), ` +
      `${report.total_entities} total rows` +
      (mode === 'execute' ? `, ${report.failed} failed` : ''),
  );
  return report;
}
