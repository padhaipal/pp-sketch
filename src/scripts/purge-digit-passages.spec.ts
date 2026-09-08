import { purgeDigitPassages, PurgeDeps } from './purge-digit-passages';

const P1 = {
  id: 'p-1',
  text: 'राम के पास 5 आम थे',
  level: 9,
  passage_type: 'narrative',
};
const P2 = {
  id: 'p-2',
  text: 'गिनती १९ तक हुई',
  level: 8,
  passage_type: 'expository',
};
const FAMILY = [
  { id: 'p-1', media_type: 'text', role: 'passage' },
  { id: 'q-1', media_type: 'text', role: 'question' },
  { id: 'o-1', media_type: 'text', role: 'option' },
  { id: 'e-1', media_type: 'text', role: 'explanation' },
  { id: 'a-1', media_type: 'audio', role: null },
  { id: 'f-1', media_type: 'flow', role: 'flow' },
];

function makeDeps(over: Partial<PurgeDeps> = {}, passages = [P1, P2]) {
  const logs: string[] = [];
  const deps: PurgeDeps = {
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("role' = 'passage'")) return passages;
      return FAMILY;
    }),
    markRolledBack: jest.fn().mockResolvedValue(undefined),
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, logs };
}

describe('purgeDigitPassages — preview (default)', () => {
  it('lists every digit-bearing family with entity breakdown and NEVER writes', async () => {
    const { deps, logs } = makeDeps();
    const report = await purgeDigitPassages(deps, 'preview');
    expect(deps.markRolledBack).not.toHaveBeenCalled();
    expect(report.mode).toBe('preview');
    expect(report.total_passages).toBe(2);
    expect(report.total_entities).toBe(FAMILY.length * 2);
    expect(report.passages.map((p) => p.outcome)).toEqual([
      'previewed',
      'previewed',
    ]);
    // ASCII and Devanagari digits both caught
    expect(report.passages.map((p) => p.passage_id)).toEqual(['p-1', 'p-2']);
    expect(logs.join('\n')).toContain('no writes will happen');
    expect(logs.join('\n')).toContain('1× audio');
  });

  it('selects only live passages with the digit regex in SQL', async () => {
    const { deps } = makeDeps();
    await purgeDigitPassages(deps, 'preview');
    const sql = (deps.query as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toContain('rolled_back = false');
    expect(sql).toContain("media_details->>'role' = 'passage'");
    expect(sql).toContain("text ~ '[0-9\u0966-\u096F]'"); // evaluated chars ०-९
  });

  it('skips a row the DTO regex disagrees with (regex-drift sanity guard)', async () => {
    const clean = {
      id: 'p-3',
      text: 'कोई अंक नहीं',
      level: 9,
      passage_type: 'narrative',
    };
    const { deps } = makeDeps({}, [clean]);
    const report = await purgeDigitPassages(deps, 'preview');
    expect(report.passages).toHaveLength(0);
    expect(report.total_passages).toBe(1); // SQL said 1, sanity guard dropped it
  });
});

describe('purgeDigitPassages — execute', () => {
  it('soft-deletes each family via markRolledBack and reports outcomes', async () => {
    const { deps } = makeDeps();
    const report = await purgeDigitPassages(deps, 'execute');
    expect(deps.markRolledBack).toHaveBeenCalledTimes(2);
    expect(deps.markRolledBack).toHaveBeenCalledWith('p-1');
    expect(deps.markRolledBack).toHaveBeenCalledWith('p-2');
    expect(report.passages.map((p) => p.outcome)).toEqual([
      'rolled_back',
      'rolled_back',
    ]);
    expect(report.failed).toBe(0);
  });

  it('continues past a failing family and counts it', async () => {
    const markRolledBack = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(undefined);
    const { deps } = makeDeps({ markRolledBack });
    const report = await purgeDigitPassages(deps, 'execute');
    expect(markRolledBack).toHaveBeenCalledTimes(2); // did not stop at p-1
    expect(report.passages[0]).toMatchObject({
      outcome: 'failed',
      error: 'db down',
    });
    expect(report.passages[1].outcome).toBe('rolled_back');
    expect(report.failed).toBe(1);
  });
});
