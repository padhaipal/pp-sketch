import type { DataSource } from 'typeorm';
import { PiiAccessService } from './pii-access.service';
import { ANONYMOUS, STAFF } from '../auth/viewer';

const T1 = '11111111-1111-4111-8111-111111111111';
const S1 = '22222222-2222-4222-8222-222222222222';
const S2 = '33333333-3333-4333-8333-333333333333';

function make(rows: { id: string }[] = []) {
  const query = jest.fn().mockResolvedValue(rows);
  return {
    svc: new PiiAccessService({ query } as unknown as DataSource),
    query,
  };
}

describe('PiiAccessService.visibleTo', () => {
  it('staff see every subject without touching the database', async () => {
    const { svc, query } = make();
    const out = await svc.visibleTo(STAFF, [S1, S2, 'legacy-id', S1]);
    expect([...out]).toEqual([S1, S2, 'legacy-id']);
    expect(query).not.toHaveBeenCalled();
  });

  it('an anonymous viewer sees nobody, without a query', async () => {
    const { svc, query } = make([{ id: S1 }]);
    expect((await svc.visibleTo(ANONYMOUS, [S1])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('a link holder: one query with the viewer and the deduplicated uuid subjects; the rows are the visible set', async () => {
    const { svc, query } = make([{ id: S1 }]);
    const out = await svc.visibleTo({ kind: 'user', id: T1 }, [
      S1,
      S2,
      S1,
      '919876543210',
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('pii-access:visible');
    // the one-hop rule, both halves
    expect(sql).toMatch(/u\.referrer_user_id = v\.id AND vg\.type = 'school'/);
    expect(sql).toMatch(/ug\.parent_id = v\.geo_entity_id/);
    expect(params).toEqual([T1, [S1, S2]]);
    expect([...out]).toEqual([S1]);
  });

  it('no subjects → no query', async () => {
    const { svc, query } = make();
    expect((await svc.visibleTo({ kind: 'user', id: T1 }, ['nope'])).size).toBe(
      0,
    );
    expect(query).not.toHaveBeenCalled();
  });
});

describe('PiiAccessService.canHear', () => {
  const B1 = '44444444-4444-4444-8444-444444444444';

  it('staff: always, without a query; anonymous, a null or non-uuid subject: never', async () => {
    const { svc, query } = make([{ '?column?': 1 }]);
    expect(await svc.canHear(STAFF, S1)).toBe(true);
    expect(await svc.canHear(ANONYMOUS, S1)).toBe(false);
    expect(await svc.canHear({ kind: 'user', id: B1 }, null)).toBe(false);
    expect(await svc.canHear({ kind: 'user', id: B1 }, '919876543210')).toBe(
      false,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('a link holder: one query walking up from the referring teacher’s geo entity; a row = audible', async () => {
    const { svc, query } = make([{ '?column?': 1 }]);
    expect(await svc.canHear({ kind: 'user', id: B1 }, S1)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('pii-access:audible');
    // the referring teacher themselves, or any STRICT ancestor of their geo entity
    expect(sql).toMatch(/v\.id = s\.referrer_user_id/);
    expect(sql).toMatch(
      /v\.geo_entity_id IN \(SELECT id FROM up WHERE depth > 0\)/,
    );
    expect(params).toEqual([B1, S1, 6]);
    query.mockResolvedValue([]);
    expect(await svc.canHear({ kind: 'user', id: B1 }, S2)).toBe(false);
  });
});

describe('PiiAccessService.canSee', () => {
  it('staff: always; null subject: never; otherwise whether the subject is in the visible set', async () => {
    const { svc, query } = make([{ id: S1 }]);
    expect(await svc.canSee(STAFF, null)).toBe(true);
    expect(await svc.canSee({ kind: 'user', id: T1 }, null)).toBe(false);
    expect(await svc.canSee({ kind: 'user', id: T1 }, S1)).toBe(true);
    query.mockResolvedValue([]);
    expect(await svc.canSee({ kind: 'user', id: T1 }, S2)).toBe(false);
    expect(await svc.canSee(ANONYMOUS, S1)).toBe(false);
  });
});
