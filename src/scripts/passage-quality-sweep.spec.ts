import type { PassageQualityVerdict } from '../media-meta-data/passage-quality';
import {
  SweepDeps,
  qualityRecordOf,
  sweepPassageQuality,
} from './passage-quality-sweep';

const GOOD: PassageQualityVerdict = {
  status: 'passed',
  true_votes: 4,
  runs: ['true', 'true', 'false', 'true', 'true'],
  valid_runs: 5,
  total_calls: 5,
  call_failures: 0,
  unparseable: 0,
};
const BAD: PassageQualityVerdict = {
  ...GOOD,
  status: 'failed_quality',
  true_votes: 1,
  runs: ['false', 'true', 'false', 'false', 'false'],
};
const UNVERIFIED: PassageQualityVerdict = {
  status: 'unverified',
  runs: ['True', 'TRUE', '{true}', '"true"', 'yes', 'no', 'True', 'TRUE'],
  valid_runs: 0,
  total_calls: 8,
  call_failures: 0,
  unparseable: 8,
};

function passageRow(
  id: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    text: `पाठ ${id}`,
    level: 9,
    passage_type: 'narrative',
    quality: null,
    ...over,
  };
}

// Routed query mock: passages listing, per-passage subtree, live counts.
function makeDeps(opts: {
  passages: Record<string, unknown>[];
  verdicts?: Record<string, PassageQualityVerdict>;
  subtrees?: Record<string, Record<string, unknown>[]>;
}) {
  const sqlLog: string[] = [];
  const query = jest.fn((sql: string, params?: unknown[]) => {
    sqlLog.push(sql);
    if (sql.includes("media_details->'quality'")) {
      return Promise.resolve(opts.passages);
    }
    if (sql.includes('WITH RECURSIVE subtree')) {
      const id = (params as string[])[0];
      return Promise.resolve(
        opts.subtrees?.[id] ?? [{ id, media_type: 'text', role: 'passage' }],
      );
    }
    if (sql.includes('GROUP BY 1, 2')) {
      return Promise.resolve([
        { passage_type: 'narrative', level: 9, passages: '2' },
      ]);
    }
    throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
  });
  const deps: SweepDeps = {
    query,
    judgePassage: jest.fn((text: string) => {
      const id = text.replace('पाठ ', '');
      return Promise.resolve(opts.verdicts?.[id] ?? GOOD);
    }),
    recordPassageQuality: jest.fn().mockResolvedValue(undefined),
    markRolledBack: jest.fn().mockResolvedValue(undefined),
    log: jest.fn(),
  };
  return { deps, sqlLog };
}

describe('sweepPassageQuality — report mode', () => {
  it('performs ZERO database writes: no INSERT/UPDATE/DELETE, no service writes', async () => {
    const { deps, sqlLog } = makeDeps({
      passages: [passageRow('p1'), passageRow('p2')],
      verdicts: { p2: BAD },
    });
    await sweepPassageQuality(deps, 'report', '2026-08-25T00:00:00Z');
    expect(sqlLog.some((sql) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(
      false,
    );
    expect(deps.recordPassageQuality).not.toHaveBeenCalled();
    expect(deps.markRolledBack).not.toHaveBeenCalled();
  });

  it('lists a failing passage with the same subtree markRolledBack would flip', async () => {
    const subtree = [
      { id: 'p2', media_type: 'text', role: 'passage' },
      { id: 'q1', media_type: 'text', role: 'question' },
      { id: 'o1', media_type: 'text', role: 'option' },
      { id: 'f1', media_type: 'flow', role: 'flow' },
      { id: 'a1', media_type: 'audio', role: null },
    ];
    const { deps, sqlLog } = makeDeps({
      passages: [passageRow('p2')],
      verdicts: { p2: BAD },
      subtrees: { p2: subtree },
    });
    const report = await sweepPassageQuality(
      deps,
      'report',
      '2026-08-25T00:00:00Z',
    );
    expect(report.failing).toHaveLength(1);
    expect(report.failing[0]).toMatchObject({
      passage_id: 'p2',
      level: 9,
      passage_type: 'narrative',
      true_votes: 1,
      text: 'पाठ p2',
      entities: subtree,
      runs: BAD.runs,
    });
    // Same walk markRolledBack's descendant flag performs: recursive over
    // input_media_id, live rows only.
    const subtreeSql = sqlLog.find((sql) => sql.includes('WITH RECURSIVE'))!;
    expect(subtreeSql).toContain('m.input_media_id = s.id');
    expect(subtreeSql).toContain('m.rolled_back = false');
  });

  it('reuses a stored version-1 verdict without calling the LLM; re-judges unverified', async () => {
    const { deps } = makeDeps({
      passages: [
        passageRow('p1', {
          quality: { version: 1, verdict: 'pass', true_votes: 5, runs: [] },
        }),
        passageRow('p2', {
          quality: { version: 1, verdict: 'unverified', runs: [] },
        }),
      ],
    });
    const report = await sweepPassageQuality(
      deps,
      'report',
      '2026-08-25T00:00:00Z',
    );
    expect(report.reused_verdicts).toBe(1);
    expect(report.judged_now).toBe(1);
    expect(deps.judgePassage).toHaveBeenCalledTimes(1);
    expect(deps.judgePassage).toHaveBeenCalledWith('पाठ p2');
  });

  it('computes post-deletion counts in memory and lists unverified without counting them as deletions', async () => {
    const { deps } = makeDeps({
      passages: [
        passageRow('p1'),
        passageRow('p2', { level: 10 }),
        passageRow('p3', { passage_type: 'expository' }),
        passageRow('p4'),
      ],
      verdicts: { p2: BAD, p3: UNVERIFIED },
    });
    const report = await sweepPassageQuality(
      deps,
      'report',
      '2026-08-25T00:00:00Z',
    );
    expect(report.failing.map((f) => f.passage_id)).toEqual(['p2']);
    expect(report.unverified.map((u) => u.passage_id)).toEqual(['p3']);
    expect(report.unverified[0].runs).toEqual(UNVERIFIED.runs);
    // p1 + p4 narrative/9 remain, plus the unverified expository row.
    expect(report.remaining_live_counts).toEqual([
      { passage_type: 'expository', level: 9, passages: 1 },
      { passage_type: 'narrative', level: 9, passages: 2 },
    ]);
  });
});

describe('sweepPassageQuality — execute mode', () => {
  it('writes quality for every judged passage and soft-deletes only the fails', async () => {
    const { deps } = makeDeps({
      passages: [passageRow('p1'), passageRow('p2'), passageRow('p3')],
      verdicts: { p2: BAD, p3: UNVERIFIED },
    });
    const report = await sweepPassageQuality(
      deps,
      'execute',
      '2026-08-25T00:00:00Z',
    );
    expect(deps.recordPassageQuality).toHaveBeenCalledTimes(3);
    expect(deps.recordPassageQuality).toHaveBeenCalledWith(
      'p2',
      qualityRecordOf(BAD),
    );
    expect(deps.recordPassageQuality).toHaveBeenCalledWith(
      'p3',
      qualityRecordOf(UNVERIFIED),
    );
    expect(deps.markRolledBack).toHaveBeenCalledTimes(1);
    expect(deps.markRolledBack).toHaveBeenCalledWith('p2');
    // Post-deletion stats come from actual DB state in execute mode.
    expect(report.remaining_live_counts).toEqual([
      { passage_type: 'narrative', level: 9, passages: 2 },
    ]);
  });
});

describe('qualityRecordOf', () => {
  it('maps verdict names and keeps the counters + runs', () => {
    expect(qualityRecordOf(GOOD)).toEqual({
      version: 1,
      verdict: 'pass',
      true_votes: 4,
      runs: GOOD.runs,
      valid_runs: 5,
      total_calls: 5,
      call_failures: 0,
      unparseable: 0,
    });
    expect(qualityRecordOf(UNVERIFIED).verdict).toBe('unverified');
    expect(qualityRecordOf(UNVERIFIED)).not.toHaveProperty('true_votes');
  });
});
