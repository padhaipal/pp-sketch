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
