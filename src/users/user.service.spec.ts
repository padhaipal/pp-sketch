// uuid is ESM-only — provide a CJS-shaped mock. validate uses the loose
// hex-shape regex (no version/variant nibble checks) so test fixtures with
// arbitrary hex bytes still classify as uuids.
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'gen-uuid'),
  validate: (s: unknown): boolean =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));

import { BadRequestException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { UserService } from './user.service';
import type { UserEntity } from './user.entity';
import type { CacheService } from '../interfaces/redis/cache';
import type { ScoreService } from '../literacy/score/score.service';
import type { MediaBucketService } from '../interfaces/media-bucket/outbound/outbound.service';

type RepoMock = {
  findOneBy: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
};
type CacheMock = { get: jest.Mock; set: jest.Mock; del: jest.Mock };
type ScoreMock = { createSeedScores: jest.Mock };
type BucketMock = { delete: jest.Mock };

function makeRepo(): RepoMock {
  return {
    findOneBy: jest.fn(),
    create: jest.fn((row) => ({ ...row })),
    save: jest.fn(),
    remove: jest.fn(),
  };
}
function makeCache(): CacheMock {
  return {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };
}
function makeScore(): ScoreMock {
  return { createSeedScores: jest.fn().mockResolvedValue(undefined) };
}
function makeBucket(): BucketMock {
  return { delete: jest.fn().mockResolvedValue(undefined) };
}
function makeDataSource(
  query: jest.Mock,
  transactionImpl?: (
    cb: (m: { query: jest.Mock }) => Promise<unknown>,
  ) => Promise<unknown>,
): DataSource {
  const transaction =
    transactionImpl ??
    ((cb: (m: { query: jest.Mock }) => Promise<unknown>) => cb({ query }));
  return { query, transaction } as unknown as DataSource;
}
function makeService(
  repo: RepoMock,
  dsQuery: jest.Mock,
  cache: CacheMock,
  score: ScoreMock,
  bucket: BucketMock = makeBucket(),
  transactionImpl?: (
    cb: (m: { query: jest.Mock }) => Promise<unknown>,
  ) => Promise<unknown>,
): UserService {
  return new UserService(
    repo as unknown as Repository<UserEntity>,
    makeDataSource(dsQuery, transactionImpl),
    cache as unknown as CacheService,
    score as unknown as ScoreService,
    bucket as unknown as MediaBucketService,
  );
}

describe('UserService.find', () => {
  it('returns the cached user without hitting the repo', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    const cached = { id: 'u1', external_id: '919999990001' };
    cache.get.mockResolvedValue(cached);

    const svc = makeService(repo, jest.fn(), cache, makeScore());
    await expect(svc.find({ id: 'u1' })).resolves.toBe(cached);
    expect(repo.findOneBy).not.toHaveBeenCalled();
  });

  it('loads by id from repo and writes both cache keys on hit', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    const user = { id: 'u1', external_id: '919999990001' };
    repo.findOneBy.mockResolvedValue(user);
    cache.get.mockResolvedValue(null);

    const svc = makeService(repo, jest.fn(), cache, makeScore());
    await expect(svc.find({ id: 'u1' })).resolves.toBe(user);
    expect(repo.findOneBy).toHaveBeenCalledWith({ id: 'u1' });
    expect(cache.set).toHaveBeenCalledWith('user:id:u1', user, 3600);
    expect(cache.set).toHaveBeenCalledWith('user:ext:919999990001', user, 3600);
  });

  it('loads by external_id (E.164 normalized) when id is not given', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    cache.get.mockResolvedValue(null);
    const user = { id: 'u1', external_id: '919999990001' };
    repo.findOneBy.mockResolvedValue(user);

    const svc = makeService(repo, jest.fn(), cache, makeScore());
    const out = await svc.find({ external_id: '919999990001' });

    expect(repo.findOneBy).toHaveBeenCalledWith({
      external_id: '919999990001',
    });
    expect(out).toBe(user);
  });

  it('returns null when repo misses', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    cache.get.mockResolvedValue(null);
    repo.findOneBy.mockResolvedValue(null);

    const svc = makeService(repo, jest.fn(), cache, makeScore());
    await expect(svc.find({ id: 'u1' })).resolves.toBeNull();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('rejects invalid find options up-front', async () => {
    const svc = makeService(makeRepo(), jest.fn(), makeCache(), makeScore());
    await expect(svc.find({} as never)).rejects.toThrow(BadRequestException);
  });
});

describe('UserService.update', () => {
  it('returns null when the user is not found', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);

    const svc = makeService(repo, jest.fn(), makeCache(), makeScore());
    await expect(
      svc.update({ id: 'u1', new_name: 'Alice' }),
    ).resolves.toBeNull();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('updates only the name when new_name is provided', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    const existing = { id: 'u1', external_id: '919999990001', name: 'Old' };
    repo.findOneBy.mockResolvedValue(existing);
    repo.save.mockImplementation(async (u) => u);

    const svc = makeService(repo, jest.fn(), cache, makeScore());
    const out = await svc.update({ id: 'u1', new_name: 'Alice' });

    expect(out).toEqual({ ...existing, name: 'Alice' });
    expect(cache.del).toHaveBeenCalledWith([
      'user:id:u1',
      'user:ext:919999990001',
    ]);
  });

  it('also evicts the OLD external_id cache key when external_id changes', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    const existing = { id: 'u1', external_id: '919999990001' };
    repo.findOneBy.mockResolvedValue(existing);
    repo.save.mockImplementation(async (u) => u);

    const svc = makeService(repo, jest.fn(), cache, makeScore());
    await svc.update({
      external_id: '919999990001',
      new_external_id: '918888880002',
    });

    const delKeys = cache.del.mock.calls[0][0] as string[];
    expect(delKeys).toEqual(
      expect.arrayContaining([
        'user:id:u1',
        'user:ext:918888880002',
        'user:ext:919999990001',
      ]),
    );
  });

  it('resolves new_referrer_external_id to the corresponding user id', async () => {
    const repo = makeRepo();
    const existing = { id: 'u1', external_id: '919999990001' };
    const refUser = { id: 'ref-1', external_id: '917777770003' };
    repo.findOneBy
      .mockResolvedValueOnce(refUser) // referrer lookup
      .mockResolvedValueOnce(existing); // self
    repo.save.mockImplementation(async (u) => u);
    const ds = jest.fn().mockResolvedValue([]); // no cycle

    const svc = makeService(repo, ds, makeCache(), makeScore());
    const out = await svc.update({
      id: 'u1',
      new_referrer_external_id: '917777770003',
    });

    expect(out?.referrer_user_id).toBe('ref-1');
  });

  it('sets referrer_user_id to null when the new referrer external_id is unknown', async () => {
    const repo = makeRepo();
    const existing = { id: 'u1', external_id: '919999990001' };
    repo.findOneBy
      .mockResolvedValueOnce(null) // referrer lookup misses
      .mockResolvedValueOnce(existing);
    repo.save.mockImplementation(async (u) => u);

    const svc = makeService(repo, jest.fn(), makeCache(), makeScore());
    const out = await svc.update({
      id: 'u1',
      new_referrer_external_id: '917777770003',
    });

    expect(out?.referrer_user_id).toBeNull();
  });

  it('rolls back and throws BadRequest on a detected referral cycle', async () => {
    const repo = makeRepo();
    const existing = { id: 'u1', external_id: '919999990001' };
    repo.findOneBy.mockResolvedValue(existing);
    // first save sets referrer; subsequent save rolls back
    repo.save.mockImplementation(async (u) => u);
    const ds = jest.fn().mockResolvedValue([{ ['1']: 1 }]); // cycle row found

    const svc = makeService(repo, ds, makeCache(), makeScore());
    await expect(
      svc.update({ id: 'u1', new_referrer_user_id: 'ref-1' }),
    ).rejects.toThrow(BadRequestException);
    // second save is the rollback (referrer_user_id reset to null)
    expect(repo.save).toHaveBeenCalledTimes(2);
    const rolledBack = repo.save.mock.calls[1][0] as {
      referrer_user_id: null;
    };
    expect(rolledBack.referrer_user_id).toBeNull();
  });
});

describe('UserService.create', () => {
  it('creates a basic user (no referrer), seeds scores, populates cache', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    const score = makeScore();
    const saved = { id: 'u1', external_id: '919999990001', name: null };
    repo.save.mockResolvedValue(saved);

    const svc = makeService(repo, jest.fn(), cache, score);
    const out = await svc.create({ external_id: '919999990001' });

    expect(out).toBe(saved);
    expect(score.createSeedScores).toHaveBeenCalledWith('u1');
    expect(cache.set).toHaveBeenCalledWith('user:id:u1', saved, 3600);
    expect(cache.set).toHaveBeenCalledWith(
      'user:ext:919999990001',
      saved,
      3600,
    );
  });

  it('with referrer_user_id: cycle detected → remove + BadRequestException', async () => {
    const repo = makeRepo();
    const score = makeScore();
    const saved = {
      id: 'u2',
      external_id: '918888880002',
      referrer_user_id: 'ref-1',
    };
    repo.save.mockResolvedValue(saved);
    const ds = jest.fn().mockResolvedValue([{ ['1']: 1 }]); // cycle

    const svc = makeService(repo, ds, makeCache(), score);
    await expect(
      svc.create({ external_id: '918888880002', referrer_user_id: 'ref-1' }),
    ).rejects.toThrow(BadRequestException);

    expect(repo.remove).toHaveBeenCalledWith(saved);
    expect(score.createSeedScores).not.toHaveBeenCalled();
  });

  it('with referrer_user_id: no cycle → seeds + caches', async () => {
    const repo = makeRepo();
    const score = makeScore();
    const saved = {
      id: 'u2',
      external_id: '918888880002',
      referrer_user_id: 'ref-1',
    };
    repo.save.mockResolvedValue(saved);
    const ds = jest.fn().mockResolvedValue([]); // no cycle

    const svc = makeService(repo, ds, makeCache(), score);
    const out = await svc.create({
      external_id: '918888880002',
      referrer_user_id: 'ref-1',
    });

    expect(out).toBe(saved);
    expect(score.createSeedScores).toHaveBeenCalledWith('u2');
  });

  it('with referrer_external_id: referrer found → uses INSERT…SELECT row', async () => {
    const repo = makeRepo();
    const score = makeScore();
    const inserted = {
      id: 'u3',
      external_id: '917777770003',
      referrer_user_id: 'ref-1',
    };
    const ds = jest
      .fn()
      .mockResolvedValueOnce([inserted]) // INSERT...SELECT returns the new row
      .mockResolvedValueOnce([]); // cycle check — clean

    const svc = makeService(repo, ds, makeCache(), score);
    const out = await svc.create({
      external_id: '917777770003',
      referrer_external_id: '919999990001',
    });

    expect(out).toBe(inserted);
    expect(score.createSeedScores).toHaveBeenCalledWith('u3');
  });

  it('with referrer_external_id: referrer not found → falls back to no-referrer insert', async () => {
    const repo = makeRepo();
    const score = makeScore();
    const saved = { id: 'u4', external_id: '917777770003' };
    repo.save.mockResolvedValue(saved);
    const ds = jest.fn().mockResolvedValueOnce([]); // INSERT…SELECT returns no rows

    const svc = makeService(repo, ds, makeCache(), score);
    const out = await svc.create({
      external_id: '917777770003',
      referrer_external_id: '919999990001',
    });

    expect(out).toBe(saved);
    expect(score.createSeedScores).toHaveBeenCalledWith('u4');
  });

  it('with referrer_external_id: cycle detected → DELETEs via raw SQL and throws', async () => {
    const repo = makeRepo();
    const score = makeScore();
    const inserted = {
      id: 'u5',
      external_id: '917777770003',
      referrer_user_id: 'ref-1',
    };
    const ds = jest
      .fn()
      .mockResolvedValueOnce([inserted]) // INSERT
      .mockResolvedValueOnce([{ ['1']: 1 }]) // cycle row
      .mockResolvedValueOnce(undefined); // DELETE

    const svc = makeService(repo, ds, makeCache(), score);
    await expect(
      svc.create({
        external_id: '917777770003',
        referrer_external_id: '919999990001',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(ds).toHaveBeenLastCalledWith('DELETE FROM users WHERE id = $1', [
      'u5',
    ]);
    expect(score.createSeedScores).not.toHaveBeenCalled();
  });

  it('rejects invalid create options up-front', async () => {
    const svc = makeService(makeRepo(), jest.fn(), makeCache(), makeScore());
    await expect(svc.create({} as never)).rejects.toThrow(BadRequestException);
  });
});

// ─── mutation hardening ──────────────────────────────────────────────────

describe('UserService — exact SQL + where-clause shapes', () => {
  it('update: cycle-check uses the WITH RECURSIVE chain query with [referrer_user_id, user.id] params', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue({ id: 'u1', external_id: 'x' });
    repo.save.mockImplementation(async (u) => ({
      ...u,
      referrer_user_id: 'ref-1',
    }));
    const ds = jest.fn().mockResolvedValue([]); // no cycle row
    const svc = makeService(repo, ds, makeCache(), makeScore());
    await svc.update({ id: 'u1', new_referrer_user_id: 'ref-1' });
    expect(ds).toHaveBeenCalledTimes(1);
    expect(ds.mock.calls[0][0]).toContain('WITH RECURSIVE chain');
    expect(ds.mock.calls[0][0]).toContain(
      'SELECT id, referrer_user_id FROM users WHERE id = $1',
    );
    expect(ds.mock.calls[0][0]).toContain(
      'JOIN chain c ON u.id = c.referrer_user_id',
    );
    expect(ds.mock.calls[0][0]).toContain('SELECT 1 FROM chain WHERE id = $2');
    expect(ds.mock.calls[0][1]).toEqual(['ref-1', 'u1']);
  });

  it('update: lookup uses { id } when id is given, { external_id } otherwise', async () => {
    const repoA = makeRepo();
    repoA.findOneBy.mockResolvedValue(null);
    await makeService(repoA, jest.fn(), makeCache(), makeScore()).update({
      id: 'u1',
      new_name: 'A',
    });
    expect(repoA.findOneBy).toHaveBeenLastCalledWith({ id: 'u1' });

    const repoB = makeRepo();
    repoB.findOneBy.mockResolvedValue(null);
    await makeService(repoB, jest.fn(), makeCache(), makeScore()).update({
      external_id: '919999990001',
      new_name: 'B',
    });
    expect(repoB.findOneBy).toHaveBeenLastCalledWith({
      external_id: '919999990001',
    });
  });

  it('update: a new_name-only update reaches save AND repopulates both cache keys', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    const existing = { id: 'u1', external_id: '919999990001', name: 'Old' };
    repo.findOneBy.mockResolvedValue(existing);
    repo.save.mockImplementation(async (u) => u);
    const svc = makeService(repo, jest.fn(), cache, makeScore());
    const out = await svc.update({ id: 'u1', new_name: 'New' });
    expect(out!.name).toBe('New');
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New' }),
    );
    expect(cache.set).toHaveBeenCalledWith(
      'user:id:u1',
      expect.anything(),
      3600,
    );
    expect(cache.set).toHaveBeenCalledWith(
      'user:ext:919999990001',
      expect.anything(),
      3600,
    );
  });

  it('update: only evicts the OLD external_id cache key when BOTH new_external_id and external_id are given', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    const existing = { id: 'u1', external_id: '919999990001' };
    repo.findOneBy.mockResolvedValue(existing);
    repo.save.mockImplementation(async (u) => ({
      ...u,
      external_id: '918888880002',
    }));
    const svc = makeService(repo, jest.fn(), cache, makeScore());
    // The new_external_id branch alone (no `external_id` field) must NOT evict
    // the old key — both must be present.
    await svc.update({ id: 'u1', new_external_id: '918888880002' });
    expect(cache.del).toHaveBeenCalledTimes(1);
    const delArg = (cache.del.mock.calls[0][0] as string[]) ?? [];
    expect(delArg).toEqual([
      'user:id:u1',
      'user:ext:918888880002', // the NEW external_id, not the old one
    ]);
  });

  it('create with referrer_user_id: cycle-check SQL + params, no cycle path', async () => {
    const repo = makeRepo();
    const saved = {
      id: 'u-new',
      external_id: '919999990001',
      referrer_user_id: 'ref-1',
    };
    repo.save.mockResolvedValue(saved);
    const ds = jest.fn().mockResolvedValue([]); // no cycle
    const svc = makeService(repo, ds, makeCache(), makeScore());
    await svc.create({
      external_id: '919999990001',
      referrer_user_id: 'ref-1',
    });
    expect(ds).toHaveBeenCalledTimes(1);
    expect(ds.mock.calls[0][0]).toContain('WITH RECURSIVE chain');
    expect(ds.mock.calls[0][1]).toEqual(['ref-1', 'u-new']);
  });

  it('create with referrer_external_id: INSERT...SELECT params + null-default for missing name', async () => {
    const repo = makeRepo();
    const ds = jest
      .fn()
      // INSERT row
      .mockResolvedValueOnce([
        {
          id: 'u-new',
          external_id: '919999990001',
          referrer_user_id: 'ref-1',
        },
      ])
      // cycle check
      .mockResolvedValueOnce([]);
    const svc = makeService(repo, ds, makeCache(), makeScore());
    await svc.create({
      external_id: '919999990001',
      referrer_external_id: '918888880002',
    });
    // INSERT call
    expect(ds.mock.calls[0][0]).toContain(
      'INSERT INTO users (external_id, name, referrer_user_id)',
    );
    expect(ds.mock.calls[0][0]).toContain(
      'SELECT $1, $2, id FROM users WHERE external_id = $3',
    );
    expect(ds.mock.calls[0][0]).toContain('RETURNING *');
    expect(ds.mock.calls[0][1]).toEqual(['919999990001', null, '918888880002']);
    // Cycle-check call
    expect(ds.mock.calls[1][0]).toContain('WITH RECURSIVE chain');
    expect(ds.mock.calls[1][1]).toEqual(['ref-1', 'u-new']);
  });

  it('create with referrer_external_id: cycle detected → DELETE FROM users WHERE id = $1', async () => {
    const repo = makeRepo();
    const ds = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'u-new',
          external_id: '919999990001',
          referrer_user_id: 'ref-1',
        },
      ]) // INSERT
      .mockResolvedValueOnce([{ '1': 1 }]) // cycle hit
      .mockResolvedValueOnce(undefined); // DELETE
    const svc = makeService(repo, ds, makeCache(), makeScore());
    await expect(
      svc.create({
        external_id: '919999990001',
        referrer_external_id: '918888880002',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(ds.mock.calls[2]).toEqual([
      'DELETE FROM users WHERE id = $1',
      ['u-new'],
    ]);
  });
});

describe('UserService.update — referrer resolution + assignments', () => {
  it('skips the cycle-check entirely when neither referrer field is provided', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue({ id: 'u1', external_id: 'x' });
    repo.save.mockImplementation(async (u) => u);
    const ds = jest.fn();
    const svc = makeService(repo, ds, makeCache(), makeScore());
    await svc.update({ id: 'u1', new_name: 'just a name' });
    expect(ds).not.toHaveBeenCalled();
  });
});

describe('UserService.findByIdOrExternalId', () => {
  const UUID = '11111111-2222-3333-4444-555555555555';

  it('routes a uuid-shaped input to find({id})', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    const user = { id: UUID, external_id: '919999990001' };
    cache.get.mockResolvedValue(null);
    repo.findOneBy.mockResolvedValue(user);

    const svc = makeService(repo, jest.fn(), cache, makeScore());
    await expect(svc.findByIdOrExternalId(UUID)).resolves.toBe(user);
    expect(repo.findOneBy).toHaveBeenCalledWith({ id: UUID });
  });

  it('routes a non-uuid input through find({external_id}), normalizing E.164', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    cache.get.mockResolvedValue(null);
    const user = { id: UUID, external_id: '919999990001' };
    repo.findOneBy.mockResolvedValue(user);

    const svc = makeService(repo, jest.fn(), cache, makeScore());
    await expect(svc.findByIdOrExternalId('+91 999 999 0001')).resolves.toBe(
      user,
    );
    // find() normalizes through validateE164PhoneNumber → canonical form.
    expect(repo.findOneBy).toHaveBeenCalledWith({
      external_id: '919999990001',
    });
  });

  it('returns null when the well-shaped identifier matches no user', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    cache.get.mockResolvedValue(null);
    repo.findOneBy.mockResolvedValue(null);

    const svc = makeService(repo, jest.fn(), cache, makeScore());
    await expect(svc.findByIdOrExternalId(UUID)).resolves.toBeNull();
  });

  it('throws BadRequestException when the input is neither a uuid nor a valid E.164', async () => {
    const repo = makeRepo();
    const svc = makeService(repo, jest.fn(), makeCache(), makeScore());
    await expect(
      svc.findByIdOrExternalId('not-a-uuid-not-a-phone'),
    ).rejects.toThrow(BadRequestException);
    expect(repo.findOneBy).not.toHaveBeenCalled();
  });
});

describe('UserService.partitionIdentifiers', () => {
  const UUID = '11111111-2222-3333-4444-555555555555';

  function svc(): UserService {
    return makeService(makeRepo(), jest.fn(), makeCache(), makeScore());
  }

  it('splits uuids into ids and E.164 inputs into externalIds', () => {
    expect(svc().partitionIdentifiers([UUID, '919999990001'])).toEqual({
      ids: [UUID],
      externalIds: ['919999990001'],
      canonical: [UUID, '919999990001'],
    });
  });

  it('normalizes E.164 inputs (strips the + and spaces)', () => {
    const out = svc().partitionIdentifiers(['+91 999 999 0001']);
    expect(out.externalIds).toEqual(['919999990001']);
    expect(out.canonical).toEqual(['919999990001']);
  });

  it('throws BadRequestException listing every bad item at once', () => {
    expect(() =>
      svc().partitionIdentifiers(['garbage-a', 'garbage-b']),
    ).toThrow(/garbage-a.*garbage-b/);
  });
});

// ─── delete() — cascade w/ per-user atomic txn ───────────────────────────────

describe('UserService.delete', () => {
  // Helper: a fake `dataSource` whose top-level `query` handles the resolve
  // SELECT, and whose `transaction(cb)` runs `cb` with a `manager.query` that
  // dispatches DELETE/UPDATE/SELECT calls through `scriptedTxn`.
  type TxnCall = { sql: string; params: unknown[] };
  function txnRunner(
    scripted: Array<unknown | ((sql: string, params: unknown[]) => unknown)>,
  ): {
    calls: TxnCall[];
    run: (
      cb: (m: { query: jest.Mock }) => Promise<unknown>,
    ) => Promise<unknown>;
  } {
    const calls: TxnCall[] = [];
    let i = 0;
    const managerQuery = jest.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const step = scripted[i++];
      if (typeof step === 'function') return (step as Function)(sql, params);
      return step;
    });
    return {
      calls,
      run: (cb) => cb({ query: managerQuery }),
    };
  }

  it('resolves a single id input, runs DELETEs, post-commit cache del + S3 cleanup', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    const bucket = makeBucket();
    const resolveSql = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'u1', external_id: '919999990001' }]);
    const txn = txnRunner([
      [{ s3_key: 'k1' }, { s3_key: 'k2' }], // media s3_keys
      [], // UPDATE referrer RETURNING (no chain)
      undefined, // DELETE scores
      undefined, // DELETE literacy_lesson_states
      undefined, // DELETE media_metadata
      [{ id: 'u1' }], // DELETE users RETURNING
    ]);

    const svc = makeService(
      repo,
      resolveSql,
      cache,
      makeScore(),
      bucket,
      txn.run,
    );

    const out = await svc.delete('u1');
    expect(out).toEqual({ deleted: ['u1'], failed: [] });

    // Resolve query
    expect(resolveSql.mock.calls[0][0]).toContain(
      'SELECT id, external_id FROM users',
    );
    expect(resolveSql.mock.calls[0][1]).toEqual([['u1']]);

    // Pre-write cache del throws on Redis failure
    expect(cache.del).toHaveBeenNthCalledWith(
      1,
      ['user:id:u1', 'user:ext:919999990001'],
      { throwOnError: true },
    );
    // Post-commit cache del (no options)
    expect(cache.del).toHaveBeenNthCalledWith(2, [
      'user:id:u1',
      'user:ext:919999990001',
    ]);

    // S3 keys both deleted
    expect(bucket.delete).toHaveBeenCalledWith('k1');
    expect(bucket.delete).toHaveBeenCalledWith('k2');

    // Txn SQL shape
    const sqls = txn.calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    expect(sqls[0]).toContain('SELECT s3_key FROM media_metadata');
    expect(sqls[1]).toContain('UPDATE users SET referrer_user_id = NULL');
    expect(sqls[1]).toContain('RETURNING id, external_id');
    expect(sqls[2]).toContain('DELETE FROM scores WHERE user_id = $1');
    expect(sqls[3]).toContain(
      'DELETE FROM literacy_lesson_states WHERE user_id = $1',
    );
    expect(sqls[4]).toContain('DELETE FROM media_metadata WHERE user_id = $1');
    expect(sqls[5]).toContain('DELETE FROM users WHERE id = $1 RETURNING id');
  });

  it('resolves a single external_id input', async () => {
    const repo = makeRepo();
    const resolveSql = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'u1', external_id: '919999990001' }]);
    const txn = txnRunner([
      [],
      [],
      undefined,
      undefined,
      undefined,
      [{ id: 'u1' }],
    ]);

    const svc = makeService(
      repo,
      resolveSql,
      makeCache(),
      makeScore(),
      makeBucket(),
      txn.run,
    );

    const out = await svc.delete('919999990001');
    expect(out.deleted).toEqual(['919999990001']);
    expect(out.failed).toEqual([]);
  });

  it('partitions a mixed array into deleted + failed', async () => {
    const repo = makeRepo();
    const resolveSql = jest.fn().mockResolvedValueOnce([
      { id: 'u1', external_id: '919999990001' },
      { id: 'u2', external_id: '918888880002' },
    ]);
    const txn = txnRunner([
      [],
      [],
      undefined,
      undefined,
      undefined,
      [{ id: 'u1' }], // user 1
      [],
      [],
      undefined,
      undefined,
      undefined,
      [{ id: 'u2' }], // user 2
    ]);

    const svc = makeService(
      repo,
      resolveSql,
      makeCache(),
      makeScore(),
      makeBucket(),
      txn.run,
    );

    const out = await svc.delete(['u1', 'unknown-input', '918888880002']);
    expect(out.deleted.sort()).toEqual(['918888880002', 'u1']);
    expect(out.failed).toEqual([
      { input: 'unknown-input', reason: 'user not found' },
    ]);
  });

  it('records a not-found input as failed without throwing', async () => {
    const repo = makeRepo();
    const resolveSql = jest.fn().mockResolvedValueOnce([]); // nothing resolves

    const svc = makeService(repo, resolveSql, makeCache(), makeScore());

    const out = await svc.delete('nope');
    expect(out).toEqual({
      deleted: [],
      failed: [{ input: 'nope', reason: 'user not found' }],
    });
  });

  it('per-user mid-batch error: that user fails, others still delete', async () => {
    const repo = makeRepo();
    const resolveSql = jest.fn().mockResolvedValueOnce([
      { id: 'u1', external_id: 'ext1' },
      { id: 'u2', external_id: 'ext2' },
    ]);
    // user 1: media SELECT throws; user 2: clean
    const calls: { sql: string; params: unknown[] }[] = [];
    let userCallIndex = 0;
    const scripts: Array<Array<unknown>> = [
      [
        () => {
          throw new Error('boom from user 1');
        },
      ],
      [[], [], undefined, undefined, undefined, [{ id: 'u2' }]],
    ];
    const transaction = (cb: (m: { query: jest.Mock }) => Promise<unknown>) => {
      const script = scripts[userCallIndex++];
      let i = 0;
      const q = jest.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        const step = script[i++];
        if (typeof step === 'function') return (step as Function)();
        return step;
      });
      return cb({ query: q });
    };

    const svc = makeService(
      repo,
      resolveSql,
      makeCache(),
      makeScore(),
      makeBucket(),
      transaction,
    );

    const out = await svc.delete(['u1', 'u2']);
    expect(out.deleted).toEqual(['u2']);
    expect(out.failed).toEqual([{ input: 'u1', reason: 'boom from user 1' }]);
  });

  it('S3 delete failure does not roll back: user still in deleted + warn', async () => {
    const repo = makeRepo();
    const bucket = makeBucket();
    bucket.delete.mockRejectedValue(new Error('s3 down'));
    const resolveSql = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'u1', external_id: 'ext1' }]);
    const txn = txnRunner([
      [{ s3_key: 'k1' }],
      [],
      undefined,
      undefined,
      undefined,
      [{ id: 'u1' }],
    ]);
    const warn = jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const svc = makeService(
      repo,
      resolveSql,
      makeCache(),
      makeScore(),
      bucket,
      txn.run,
    );

    const out = await svc.delete('u1');
    expect(out).toEqual({ deleted: ['u1'], failed: [] });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/S3 delete failed for key k1.*s3 down/),
    );
    warn.mockRestore();
  });

  it('pre-write cache del throwing aborts that user → failed, no DB writes', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    cache.del.mockImplementation(
      (_keys: unknown, opts?: { throwOnError?: boolean }) => {
        if (opts?.throwOnError) return Promise.reject(new Error('redis down'));
        return Promise.resolve(undefined);
      },
    );
    const resolveSql = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'u1', external_id: 'ext1' }]);
    // Only the media SELECT runs before pre-write cache del. After cache
    // del throws, no further txn SQL must execute.
    const txn = txnRunner([[]]);

    const svc = makeService(
      repo,
      resolveSql,
      cache,
      makeScore(),
      makeBucket(),
      txn.run,
    );

    const out = await svc.delete('u1');
    expect(out.deleted).toEqual([]);
    expect(out.failed).toEqual([{ input: 'u1', reason: 'redis down' }]);
    // Only the media SELECT ran; no UPDATE/DELETE statements.
    expect(txn.calls).toHaveLength(1);
    expect(txn.calls[0].sql).toContain('SELECT s3_key FROM media_metadata');
  });

  it('post-commit cache del failure: user still in deleted + warn', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    let delCall = 0;
    cache.del.mockImplementation(() => {
      delCall += 1;
      if (delCall === 2) return Promise.reject(new Error('post-commit fail'));
      return Promise.resolve(undefined);
    });
    const resolveSql = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'u1', external_id: 'ext1' }]);
    const txn = txnRunner([
      [],
      [],
      undefined,
      undefined,
      undefined,
      [{ id: 'u1' }],
    ]);
    const warn = jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const svc = makeService(
      repo,
      resolveSql,
      cache,
      makeScore(),
      makeBucket(),
      txn.run,
    );

    const out = await svc.delete('u1');
    expect(out.deleted).toEqual(['u1']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Post-commit cache del failed for user u1.*post-commit fail/,
      ),
    );
    warn.mockRestore();
  });

  it('referrer chain: invalidates cache keys for each nulled referrer', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    const resolveSql = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'u1', external_id: 'ext1' }]);
    const txn = txnRunner([
      [],
      [
        { id: 'ref-a', external_id: 'phone-a' },
        { id: 'ref-b', external_id: 'phone-b' },
      ],
      undefined,
      undefined,
      undefined,
      [{ id: 'u1' }],
    ]);

    const svc = makeService(
      repo,
      resolveSql,
      cache,
      makeScore(),
      makeBucket(),
      txn.run,
    );

    await svc.delete('u1');

    expect(cache.del).toHaveBeenCalledWith([
      'user:id:ref-a',
      'user:ext:phone-a',
    ]);
    expect(cache.del).toHaveBeenCalledWith([
      'user:id:ref-b',
      'user:ext:phone-b',
    ]);
  });

  it('DELETE FROM users returning zero rows → NotFoundException surfaced as failed', async () => {
    const repo = makeRepo();
    const resolveSql = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'u1', external_id: 'ext1' }]);
    const txn = txnRunner([
      [],
      [],
      undefined,
      undefined,
      undefined,
      [], // 0 rows from RETURNING
    ]);

    const svc = makeService(
      repo,
      resolveSql,
      makeCache(),
      makeScore(),
      makeBucket(),
      txn.run,
    );

    const out = await svc.delete('u1');
    expect(out.deleted).toEqual([]);
    expect(out.failed[0].input).toBe('u1');
    expect(out.failed[0].reason).toMatch(/vanished mid-transaction/);
  });

  it('empty array input returns empty result without DB hits', async () => {
    const repo = makeRepo();
    const resolveSql = jest.fn();
    const svc = makeService(repo, resolveSql, makeCache(), makeScore());
    await expect(svc.delete([])).resolves.toEqual({
      deleted: [],
      failed: [],
    });
    expect(resolveSql).not.toHaveBeenCalled();
  });

  it('de-duplicates the same user passed twice (id + external_id)', async () => {
    const repo = makeRepo();
    const resolveSql = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'u1', external_id: 'ext1' }]);
    const txn = txnRunner([
      [],
      [],
      undefined,
      undefined,
      undefined,
      [{ id: 'u1' }],
    ]);

    const svc = makeService(
      repo,
      resolveSql,
      makeCache(),
      makeScore(),
      makeBucket(),
      txn.run,
    );

    const out = await svc.delete(['u1', 'ext1']);
    // Only one user processed; the second input is silently absorbed.
    expect(out.deleted).toEqual(['u1']);
    expect(out.failed).toEqual([]);
  });
});
