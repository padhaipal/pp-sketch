import type { DataSource } from 'typeorm';
import { GeoEntityService, MAX_ANCESTOR_DEPTH } from './geo-entity.service';
import type { GeoEntityUpsertRow } from './geo-entity.dto';

// Fixture tree: IN → state 01 → district 0101 → block 010101 → schools; one
// school (s-noblock-cluster) sits directly under the block with no cluster
// level at all (the seeded shape), and a second block holds a closed school.
interface Node {
  id: string;
  type: string;
  parent_id: string | null;
  code: string;
  name: string;
  status: string;
  deleted_at: Date | null;
  has_boundary: boolean;
  lat: number | null;
  lng: number | null;
}
const T: Node[] = [
  n('in', 'country', null, 'IN', 'India'),
  n('st', 'state', 'in', '01', 'Jammu & Kashmir'),
  n('di', 'district', 'st', '0101', 'Kupwara'),
  n('bl1', 'block', 'di', '010101', 'Kupwara'),
  n('bl2', 'block', 'di', '010102', 'Handwara'),
  n('sc1', 'school', 'bl1', '01010100101', 'PS Kupwara'),
  n('sc2', 'school', 'bl1', '01010100102', 'MS Kupwara'),
  n('sc3', 'school', 'bl1', '01010100103', 'Old School', 'closed'),
  n('sc4', 'school', 'bl2', '01010200101', 'PS Handwara'),
  n(
    'sc5',
    'school',
    'bl2',
    '01010200102',
    'Deleted School',
    'operational',
    new Date(),
  ),
];
function n(
  id: string,
  type: string,
  parent_id: string | null,
  code: string,
  name: string,
  status = 'operational',
  deleted_at: Date | null = null,
): Node {
  return {
    id,
    type,
    parent_id,
    code,
    name,
    status,
    deleted_at,
    has_boundary: false,
    lat: null,
    lng: null,
  };
}
const byId = new Map(T.map((x) => [x.id, x]));

// A fake DataSource.query that evaluates the service's SQL against the
// fixture with the same semantics (ancestors: parents root-first, capped;
// descendants: expand until the target type, filter operational + not
// deleted, keyset by id). Unknown SQL returns [].
function fakeQuery(sql: string, params: unknown[] = []): unknown[] {
  if (/WITH RECURSIVE up AS/.test(sql)) {
    const [id, maxDepth] = params as [string, number];
    const out: Node[] = [];
    let cur = byId.get(byId.get(id)?.parent_id ?? '');
    while (cur && out.length < maxDepth) {
      out.push(cur);
      cur = byId.get(cur.parent_id ?? '');
    }
    return out.reverse();
  }
  if (/WITH RECURSIVE tree AS/.test(sql)) {
    const [id, type, cursor, limit] = params as [
      string,
      string,
      string | null,
      number,
    ];
    const found: Node[] = [];
    const frontier = T.filter((x) => x.parent_id === id);
    const hops: number[] = [];
    const walk = (nodes: Node[], hop: number) => {
      for (const node of nodes) {
        if (node.type === type) {
          found.push(node);
          hops.push(hop);
        } else {
          walk(
            T.filter((x) => x.parent_id === node.id),
            hop + 1,
          );
        }
      }
    };
    walk(frontier, 1);
    (fakeQuery as unknown as { lastHops: number[] }).lastHops = hops;
    return found
      .filter((x) => x.status === 'operational' && x.deleted_at === null)
      .filter((x) => cursor === null || x.id > cursor)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }
  if (/FROM geo_entity WHERE id = \$1/.test(sql)) {
    const node = byId.get(params[0] as string);
    return node ? [node] : [];
  }
  if (/SELECT id, code FROM geo_entity WHERE type = \$1/.test(sql)) {
    return T.filter((x) => x.type === params[0]).map(({ id, code }) => ({
      id,
      code,
    }));
  }
  return [];
}

function makeService(query = jest.fn(fakeQuery)) {
  return {
    svc: new GeoEntityService({ query } as unknown as DataSource),
    query,
  };
}

describe('GeoEntityService.ancestors', () => {
  it('returns the chain root first, excluding the entity itself, capped at MAX_ANCESTOR_DEPTH', async () => {
    const { svc, query } = makeService();
    const out = await svc.ancestors('sc1');
    expect(out.map((x) => x.id)).toEqual(['in', 'st', 'di', 'bl1']);
    expect(query.mock.calls[0][1]).toEqual(['sc1', MAX_ANCESTOR_DEPTH]);
    expect(MAX_ANCESTOR_DEPTH).toBe(6);
  });

  it('is empty for the root', async () => {
    const { svc } = makeService();
    expect(await svc.ancestors('in')).toEqual([]);
  });
});

describe('GeoEntityService.descendants', () => {
  it("a block's schools are its direct children in one hop", async () => {
    const { svc } = makeService();
    const page = await svc.descendants('bl1', 'school', { limit: 100 });
    expect(page.items.map((x) => x.id)).toEqual(['sc1', 'sc2']);
    expect(page.next_cursor).toBeNull();
    expect((fakeQuery as unknown as { lastHops: number[] }).lastHops).toEqual([
      1, 1, 1,
    ]);
  });

  it('stops expanding at the target type in the SQL (recursion guard)', async () => {
    const { svc, query } = makeService();
    await svc.descendants('di', 'school', { limit: 10 });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/WHERE t\.type <> \$2/);
    expect(sql).toMatch(/g\.status = 'operational'/);
    expect(sql).toMatch(/g\.deleted_at IS NULL/);
  });

  it('walks district → block → school, dropping closed and deleted schools', async () => {
    const { svc } = makeService();
    const page = await svc.descendants('di', 'school', { limit: 10 });
    expect(page.items.map((x) => x.id)).toEqual(['sc1', 'sc2', 'sc4']);
  });

  it('keyset-pages by id and asks for limit + 1 rows', async () => {
    const { svc, query } = makeService();
    const first = await svc.descendants('di', 'school', { limit: 2 });
    expect(first.items.map((x) => x.id)).toEqual(['sc1', 'sc2']);
    expect(first.next_cursor).toBe('sc2');
    expect(query.mock.calls[0][1]).toEqual(['di', 'school', null, 3]);

    const second = await svc.descendants('di', 'school', {
      cursor: first.next_cursor,
      limit: 2,
    });
    expect(second.items.map((x) => x.id)).toEqual(['sc4']);
    expect(second.next_cursor).toBeNull();
  });
});

describe('GeoEntityService.search', () => {
  it('escapes LIKE metacharacters and passes type/limit', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { svc } = makeService(query);
    await svc.search('50%_x', 'district', 5);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['50\\%\\_x', 'district', 5]);
    expect(String(sql)).toMatch(/ESCAPE '\\'/);
    expect(String(sql)).toMatch(/ORDER BY g\.type, g\.name/);
  });

  it('returns [] for a blank query without touching the database', async () => {
    const query = jest.fn();
    const { svc } = makeService(query);
    expect(await svc.search('   ')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('defaults the limit to 20 and type to null', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { svc } = makeService(query);
    await svc.search('kup');
    expect(query.mock.calls[0][1]).toEqual(['kup', null, 20]);
  });
});

describe('GeoEntityService.upsertBatch', () => {
  const row: GeoEntityUpsertRow = {
    type: 'school',
    parent_id: 'bl1',
    code: '01010100101',
    name: 'PS Kupwara',
    lgd_code: null,
    lat: 34.5,
    lng: 74.3,
    has_boundary: false,
    status: 'operational',
    management_group: 'government',
    class_from: 1,
    class_to: 5,
    attributes: { schoolId: '1000001' },
    source: 'kys_by_year',
    source_pulled_at: new Date('2026-09-01T00:00:00Z'),
  };

  it('is a no-op for an empty batch', async () => {
    const query = jest.fn();
    const { svc } = makeService(query);
    await svc.upsertBatch([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('sends one unnest INSERT with 15 column arrays and overwrites every non-key column except id/created_at/deleted_at', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { svc } = makeService(query);
    await svc.upsertBatch([row, { ...row, code: '01010100102' }]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/ON CONFLICT \("type", "code"\) DO UPDATE SET/);
    expect(String(sql)).not.toMatch(/"id" = EXCLUDED/);
    expect(String(sql)).not.toMatch(/"created_at" = EXCLUDED/);
    expect(String(sql)).not.toMatch(/"deleted_at" = EXCLUDED/);
    expect(String(sql)).toMatch(/"updated_at" = now\(\)/);
    expect(String(sql)).toMatch(/"parent_id" = EXCLUDED\."parent_id"/);
    expect(params).toHaveLength(15);
    expect(params[2]).toEqual(['01010100101', '01010100102']);
    expect(params[12]).toEqual([
      '{"schoolId":"1000001"}',
      '{"schoolId":"1000001"}',
    ]);
  });

  it('a block re-seeded with null coordinates keeps the ones it has; every other level overwrites', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { svc } = makeService(query);
    await svc.upsertBatch([
      { ...row, type: 'block', code: '010101', lat: null, lng: null },
    ]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(
      /"lat" = CASE WHEN EXCLUDED\."type" = 'block' THEN COALESCE\(EXCLUDED\."lat", geo_entity\."lat"\) ELSE EXCLUDED\."lat" END/,
    );
    expect(sql).toMatch(
      /"lng" = CASE WHEN EXCLUDED\."type" = 'block' THEN COALESCE\(EXCLUDED\."lng", geo_entity\."lng"\) ELSE EXCLUDED\."lng" END/,
    );
    // Nothing else is COALESCEd — a school losing its coordinate goes null.
    expect(sql).not.toMatch(/COALESCE\(EXCLUDED\."name"/);
  });

  it('updateBlockCoordinates writes only blocks, through the manager when given', async () => {
    const query = jest.fn();
    const { svc } = makeService(query);
    const manager = { query: jest.fn().mockResolvedValue(undefined) };
    await svc.updateBlockCoordinates('b1', 26.8, 80.9, manager as never);
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE geo_entity b SET lat = \$2, lng = \$3, updated_at = now\(\)\s+WHERE b\.id = \$1 AND b\.type = 'block'/,
      ),
      ['b1', 26.8, 80.9],
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('uses the transaction manager when given', async () => {
    const query = jest.fn();
    const { svc } = makeService(query);
    const manager = { query: jest.fn().mockResolvedValue(undefined) };
    await svc.upsertBatch([row], manager as never);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GeoEntityService — merged pointers', () => {
  it('linkMergedSchools joins schIdMerged → schoolId for non-operational schools only and returns the count', async () => {
    const query = jest.fn().mockResolvedValue([[], 7]);
    const { svc } = makeService(query);
    expect(await svc.linkMergedSchools()).toBe(7);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/s\.status <> 'operational'/);
    expect(sql).toMatch(/NOT IN \('', '0'\)/);
    expect(sql).toMatch(/t\.id <> s\.id/);
    expect(sql).toMatch(
      /t\.attributes->>'schoolId' = s\.attributes->>'schIdMerged'/,
    );
  });

  it('clearMergedInto nulls the given ids and skips an empty list', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { svc } = makeService(query);
    await svc.clearMergedInto([]);
    expect(query).not.toHaveBeenCalled();
    await svc.clearMergedInto(['a', 'b']);
    expect(query.mock.calls[0][1]).toEqual([['a', 'b']]);
    expect(String(query.mock.calls[0][0])).toMatch(/merged_into_id = NULL/);
  });
});

describe('GeoEntityService lookups', () => {
  it('getById / getByCode / codeMap', async () => {
    const { svc } = makeService();
    expect((await svc.getById('bl2'))?.name).toBe('Handwara');
    expect(await svc.getById('nope')).toBeNull();
    const map = await svc.codeMap('block');
    expect([...map.entries()]).toEqual([
      ['010101', 'bl1'],
      ['010102', 'bl2'],
    ]);
  });
});
