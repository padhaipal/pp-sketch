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

type RepoMock = {
  findOneBy: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
};
type CacheMock = { get: jest.Mock; set: jest.Mock; del: jest.Mock };
type ScoreMock = { createSeedScores: jest.Mock };

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
function makeDataSource(query: jest.Mock): DataSource {
  return { query } as unknown as DataSource;
}
function makeService(
  repo: RepoMock,
  dsQuery: jest.Mock,
  cache: CacheMock,
  score: ScoreMock,
): UserService {
  return new UserService(
    repo as unknown as Repository<UserEntity>,
    makeDataSource(dsQuery),
    cache as unknown as CacheService,
    score as unknown as ScoreService,
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
    expect(cache.set).toHaveBeenCalledWith(
      'user:ext:919999990001',
      user,
      3600,
    );
  });

  it('loads by external_id (E.164 normalized) when id is not given', async () => {
    const repo = makeRepo();
    const cache = makeCache();
    cache.get.mockResolvedValue(null);
    const user = { id: 'u1', external_id: '919999990001' };
    repo.findOneBy.mockResolvedValue(user);

    const svc = makeService(repo, jest.fn(), cache, makeScore());
    const out = await svc.find({ external_id: '919999990001' });

    expect(repo.findOneBy).toHaveBeenCalledWith({ external_id: '919999990001' });
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
    await expect(svc.update({ id: 'u1', new_name: 'Alice' })).resolves.toBeNull();
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
    expect(cache.set).toHaveBeenCalledWith('user:id:u1', expect.anything(), 3600);
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
    expect(ds.mock.calls[0][1]).toEqual([
      '919999990001',
      null,
      '918888880002',
    ]);
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
    expect(() => svc().partitionIdentifiers(['garbage-a', 'garbage-b'])).toThrow(
      /garbage-a.*garbage-b/,
    );
  });
});
