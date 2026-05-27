import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { LetterService } from './letter.service';
import { LetterEntity } from './letter.entity';

type RepoMock = {
  create: jest.Mock;
  save: jest.Mock;
  findOneBy: jest.Mock;
  delete: jest.Mock;
};

function makeRepoMock(): RepoMock {
  return {
    create: jest.fn((row) => ({ ...row })),
    save: jest.fn(),
    findOneBy: jest.fn(),
    delete: jest.fn(),
  };
}

function makeService(repo: RepoMock): LetterService {
  return new LetterService(repo as unknown as Repository<LetterEntity>);
}

describe('LetterService.create', () => {
  it('persists a new letter and returns the saved row', async () => {
    const repo = makeRepoMock();
    const saved = { id: 'u1', grapheme: 'क', media_metadata_id: null };
    repo.save.mockResolvedValue(saved);
    const svc = makeService(repo);

    const result = await svc.create({ grapheme: 'क' });

    expect(repo.create).toHaveBeenCalledWith({
      grapheme: 'क',
      media_metadata_id: null,
    });
    expect(repo.save).toHaveBeenCalledWith({
      grapheme: 'क',
      media_metadata_id: null,
    });
    expect(result).toBe(saved);
  });

  it('passes media_metadata_id through when provided', async () => {
    const repo = makeRepoMock();
    repo.save.mockResolvedValue({ id: 'u1', grapheme: 'क', media_metadata_id: 'm1' });
    const svc = makeService(repo);

    await svc.create({ grapheme: 'क', media_metadata_id: 'm1' });

    expect(repo.create).toHaveBeenCalledWith({
      grapheme: 'क',
      media_metadata_id: 'm1',
    });
  });

  it('throws BadRequestException on unique-violation (23505)', async () => {
    const repo = makeRepoMock();
    repo.save.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const svc = makeService(repo);

    await expect(svc.create({ grapheme: 'क' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rethrows non-23505 errors as-is', async () => {
    const repo = makeRepoMock();
    const err = Object.assign(new Error('boom'), { code: '99999' });
    repo.save.mockRejectedValue(err);
    const svc = makeService(repo);

    await expect(svc.create({ grapheme: 'क' })).rejects.toBe(err);
  });

  it('rejects invalid options up-front (delegates to validator)', async () => {
    const repo = makeRepoMock();
    const svc = makeService(repo);

    await expect(
      svc.create({} as unknown as { grapheme: string }),
    ).rejects.toThrow(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('LetterService.createBulk', () => {
  it('creates one entity per item and saves them as a batch', async () => {
    const repo = makeRepoMock();
    const saved = [
      { id: 'u1', grapheme: 'क', media_metadata_id: null },
      { id: 'u2', grapheme: 'ख', media_metadata_id: 'm2' },
    ];
    repo.save.mockResolvedValue(saved);
    const svc = makeService(repo);

    const result = await svc.createBulk({
      items: [{ grapheme: 'क' }, { grapheme: 'ख', media_metadata_id: 'm2' }],
    });

    expect(repo.create).toHaveBeenCalledTimes(2);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledWith([
      { grapheme: 'क', media_metadata_id: null },
      { grapheme: 'ख', media_metadata_id: 'm2' },
    ]);
    expect(result).toBe(saved);
  });

  it('throws BadRequestException on unique-violation (23505)', async () => {
    const repo = makeRepoMock();
    repo.save.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const svc = makeService(repo);

    await expect(
      svc.createBulk({ items: [{ grapheme: 'क' }] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rethrows non-23505 errors as-is', async () => {
    const repo = makeRepoMock();
    const err = Object.assign(new Error('boom'), { code: '42P01' });
    repo.save.mockRejectedValue(err);
    const svc = makeService(repo);

    await expect(
      svc.createBulk({ items: [{ grapheme: 'क' }] }),
    ).rejects.toBe(err);
  });
});

describe('LetterService.update', () => {
  it('returns null when the letter does not exist', async () => {
    const repo = makeRepoMock();
    repo.findOneBy.mockResolvedValue(null);
    const svc = makeService(repo);

    const result = await svc.update({ grapheme: 'क', new_grapheme: 'ख' });

    expect(result).toBeNull();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('updates grapheme only when new_grapheme is provided', async () => {
    const repo = makeRepoMock();
    const existing = { id: 'u1', grapheme: 'क', media_metadata_id: 'm1' };
    repo.findOneBy.mockResolvedValue(existing);
    repo.save.mockImplementation(async (row) => row);
    const svc = makeService(repo);

    const result = await svc.update({ grapheme: 'क', new_grapheme: 'ख' });

    expect(result).toEqual({ id: 'u1', grapheme: 'ख', media_metadata_id: 'm1' });
  });

  it('updates media_metadata_id only when new_media_metadata_id is provided', async () => {
    const repo = makeRepoMock();
    const existing = { id: 'u1', grapheme: 'क', media_metadata_id: 'm1' };
    repo.findOneBy.mockResolvedValue(existing);
    repo.save.mockImplementation(async (row) => row);
    const svc = makeService(repo);

    const result = await svc.update({
      grapheme: 'क',
      new_media_metadata_id: 'm2',
    });

    expect(result).toEqual({ id: 'u1', grapheme: 'क', media_metadata_id: 'm2' });
  });

  it('allows clearing media_metadata_id by passing null', async () => {
    const repo = makeRepoMock();
    const existing = { id: 'u1', grapheme: 'क', media_metadata_id: 'm1' };
    repo.findOneBy.mockResolvedValue(existing);
    repo.save.mockImplementation(async (row) => row);
    const svc = makeService(repo);

    const result = await svc.update({
      grapheme: 'क',
      new_media_metadata_id: null,
    });

    expect(result).toEqual({ id: 'u1', grapheme: 'क', media_metadata_id: null });
  });

  it('updates both fields when both are provided', async () => {
    const repo = makeRepoMock();
    const existing = { id: 'u1', grapheme: 'क', media_metadata_id: 'm1' };
    repo.findOneBy.mockResolvedValue(existing);
    repo.save.mockImplementation(async (row) => row);
    const svc = makeService(repo);

    const result = await svc.update({
      grapheme: 'क',
      new_grapheme: 'ख',
      new_media_metadata_id: 'm2',
    });

    expect(result).toEqual({ id: 'u1', grapheme: 'ख', media_metadata_id: 'm2' });
  });

  it('throws BadRequestException when save hits unique-violation', async () => {
    const repo = makeRepoMock();
    repo.findOneBy.mockResolvedValue({ id: 'u1', grapheme: 'क', media_metadata_id: null });
    repo.save.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const svc = makeService(repo);

    await expect(
      svc.update({ grapheme: 'क', new_grapheme: 'ख' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rethrows non-23505 save errors', async () => {
    const repo = makeRepoMock();
    repo.findOneBy.mockResolvedValue({ id: 'u1', grapheme: 'क', media_metadata_id: null });
    const err = Object.assign(new Error('boom'), { code: '08000' });
    repo.save.mockRejectedValue(err);
    const svc = makeService(repo);

    await expect(
      svc.update({ grapheme: 'क', new_grapheme: 'ख' }),
    ).rejects.toBe(err);
  });
});

describe('LetterService.delete', () => {
  it('returns true when a row was affected', async () => {
    const repo = makeRepoMock();
    repo.delete.mockResolvedValue({ affected: 1 });
    const svc = makeService(repo);

    await expect(svc.delete({ grapheme: 'क' })).resolves.toBe(true);
    expect(repo.delete).toHaveBeenCalledWith({ grapheme: 'क' });
  });

  it('returns false when zero rows affected', async () => {
    const repo = makeRepoMock();
    repo.delete.mockResolvedValue({ affected: 0 });
    const svc = makeService(repo);

    await expect(svc.delete({ grapheme: 'क' })).resolves.toBe(false);
  });

  it('returns false when affected is undefined', async () => {
    const repo = makeRepoMock();
    repo.delete.mockResolvedValue({});
    const svc = makeService(repo);

    await expect(svc.delete({ grapheme: 'क' })).resolves.toBe(false);
  });

  it('throws BadRequestException on FK-violation (23503)', async () => {
    const repo = makeRepoMock();
    repo.delete.mockRejectedValue(Object.assign(new Error('fk'), { code: '23503' }));
    const svc = makeService(repo);

    await expect(svc.delete({ grapheme: 'क' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rethrows non-23503 errors', async () => {
    const repo = makeRepoMock();
    const err = Object.assign(new Error('boom'), { code: '99999' });
    repo.delete.mockRejectedValue(err);
    const svc = makeService(repo);

    await expect(svc.delete({ grapheme: 'क' })).rejects.toBe(err);
  });
});
