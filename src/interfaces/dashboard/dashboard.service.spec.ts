const mockRandomBytes = jest.fn();
jest.mock('node:crypto', () => {
  const actual = jest.requireActual('node:crypto');
  return {
    ...actual,
    randomBytes: (...args: unknown[]) => mockRandomBytes(...args),
  };
});

import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DashboardService } from './dashboard.service';

function makeDataSource(query: jest.Mock): DataSource {
  return { query } as unknown as DataSource;
}

function makeService(query: jest.Mock): {
  service: DashboardService;
  query: jest.Mock;
} {
  return { service: new DashboardService(makeDataSource(query)), query };
}

beforeEach(() => {
  mockRandomBytes.mockReset();
});

describe('DashboardService.submitAnswer', () => {
  it('upserts via ON CONFLICT and passes session/index/answer in order', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(query);

    await service.submitAnswer({
      session_id: 'sess-1',
      question_index: 2,
      answer: 7,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO quiz_responses/);
    expect(sql).toMatch(
      /ON CONFLICT ON CONSTRAINT uq_quiz_responses_session_question/,
    );
    expect(params).toEqual(['sess-1', 2, 7]);
  });
});

describe('DashboardService.getAnswersForQuestion', () => {
  it('queries by question_index only when excludeSession is undefined', async () => {
    const query = jest.fn().mockResolvedValue([{ answer: '3' }, { answer: 5 }]);
    const { service } = makeService(query);

    const out = await service.getAnswersForQuestion(2);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/question_index = \$1/);
    expect(sql).not.toMatch(/session_id/);
    expect(params).toEqual([2]);
    expect(out).toEqual([3, 5]);
  });

  it('adds session_id <> $2 when excludeSession is provided', async () => {
    const query = jest.fn().mockResolvedValue([{ answer: 4 }]);
    const { service } = makeService(query);

    const out = await service.getAnswersForQuestion(2, 'sess-X');

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/session_id <> \$2/);
    expect(params).toEqual([2, 'sess-X']);
    expect(out).toEqual([4]);
  });

  it('returns [] when no rows match', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { service } = makeService(query);

    await expect(service.getAnswersForQuestion(2)).resolves.toEqual([]);
  });
});

describe('DashboardService.subscribeEmail', () => {
  it('normalizes email (trim + lowercase) and stores trimmed name', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(query);

    await service.subscribeEmail({
      email: '  Foo@Bar.COM  ',
      name: '  Alice  ',
    });

    const [, params] = query.mock.calls[0];
    expect(params).toEqual(['foo@bar.com', 'Alice']);
  });

  it('stores null name when name is missing', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(query);

    await service.subscribeEmail({ email: 'a@b.com' });

    expect(query.mock.calls[0][1]).toEqual(['a@b.com', null]);
  });

  it('stores null name when name is whitespace-only', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(query);

    await service.subscribeEmail({ email: 'a@b.com', name: '   ' });

    expect(query.mock.calls[0][1]).toEqual(['a@b.com', null]);
  });

  it('stores null name when name is empty string', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(query);

    await service.subscribeEmail({ email: 'a@b.com', name: '' });

    expect(query.mock.calls[0][1]).toEqual(['a@b.com', null]);
  });
});

describe('DashboardService.getMailingListSubscribers', () => {
  it('returns rows from the query verbatim, ordered by created_at DESC', async () => {
    const rows = [
      { email: 'a@b.com', name: 'A', created_at: new Date('2026-05-01') },
      { email: 'c@d.com', name: null, created_at: new Date('2026-04-01') },
    ];
    const query = jest.fn().mockResolvedValue(rows);
    const { service } = makeService(query);

    const out = await service.getMailingListSubscribers();

    expect(query.mock.calls[0][0]).toMatch(/ORDER BY created_at DESC/);
    expect(out).toBe(rows);
  });
});

describe('DashboardService.createOrGetShareToken', () => {
  function tokenFor(byte: number): string {
    return Buffer.from(new Array(9).fill(byte)).toString('base64url');
  }

  it('returns the existing token when one is already mapped to the session', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ token: 'existing-tok' }]); // SELECT
    const { service } = makeService(query);

    const out = await service.createOrGetShareToken('sess-1');

    expect(out).toBe('existing-tok');
    expect(query).toHaveBeenCalledTimes(1);
    expect(mockRandomBytes).not.toHaveBeenCalled();
  });

  it('allocates and returns a fresh token when none exists', async () => {
    mockRandomBytes.mockReturnValue(Buffer.from(new Array(9).fill(0xa1)));
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // SELECT existing → none
      .mockResolvedValueOnce(undefined); // INSERT success
    const { service } = makeService(query);

    const out = await service.createOrGetShareToken('sess-2');

    expect(out).toBe(tokenFor(0xa1));
    expect(query).toHaveBeenCalledTimes(2);
    const [insertSql, insertParams] = query.mock.calls[1];
    expect(insertSql).toMatch(/INSERT INTO quiz_share_tokens/);
    expect(insertParams).toEqual([tokenFor(0xa1), 'sess-2']);
  });

  it('returns the winning token when a concurrent insert raced and won (23505 + winner found)', async () => {
    mockRandomBytes.mockReturnValue(Buffer.from(new Array(9).fill(0xb2)));
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // initial SELECT — empty
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' })) // INSERT collides
      .mockResolvedValueOnce([{ token: 'winner-tok' }]); // re-SELECT finds winner
    const { service } = makeService(query);

    const out = await service.createOrGetShareToken('sess-3');

    expect(out).toBe('winner-tok');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('retries with a new token on PK collision (23505 but no session winner)', async () => {
    mockRandomBytes
      .mockReturnValueOnce(Buffer.from(new Array(9).fill(0xc1))) // attempt 1
      .mockReturnValueOnce(Buffer.from(new Array(9).fill(0xc2))); // attempt 2
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // SELECT existing
      .mockRejectedValueOnce(Object.assign(new Error('pk'), { code: '23505' })) // INSERT 1
      .mockResolvedValueOnce([]) // SELECT winner — none (PK collision, not session collision)
      .mockResolvedValueOnce(undefined); // INSERT 2 success
    const { service } = makeService(query);

    const out = await service.createOrGetShareToken('sess-4');

    expect(out).toBe(tokenFor(0xc2));
    expect(mockRandomBytes).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-23505 insert errors immediately', async () => {
    mockRandomBytes.mockReturnValue(Buffer.from(new Array(9).fill(0xd1)));
    const err = Object.assign(new Error('boom'), { code: '08000' });
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // SELECT existing
      .mockRejectedValueOnce(err); // INSERT non-23505
    const { service } = makeService(query);

    await expect(service.createOrGetShareToken('sess-5')).rejects.toBe(err);
  });

  it('throws after 5 retries when every insert PK-collides without a winner', async () => {
    for (let i = 0; i < 5; i++) {
      mockRandomBytes.mockReturnValueOnce(
        Buffer.from(new Array(9).fill(0x10 + i)),
      );
    }
    const query = jest.fn();
    // initial SELECT → empty
    query.mockResolvedValueOnce([]);
    // 5 iterations of: INSERT collide (23505) + SELECT winner → empty
    for (let i = 0; i < 5; i++) {
      query.mockRejectedValueOnce(
        Object.assign(new Error('pk'), { code: '23505' }),
      );
      query.mockResolvedValueOnce([]); // no winner
    }
    const { service } = makeService(query);

    await expect(service.createOrGetShareToken('sess-6')).rejects.toThrow(
      'failed to allocate share token after 5 attempts',
    );
    expect(mockRandomBytes).toHaveBeenCalledTimes(5);
  });
});

describe('DashboardService.getShareData', () => {
  it('throws NotFoundException when the token does not resolve', async () => {
    const query = jest.fn().mockResolvedValueOnce([]); // SELECT session_id — none
    const { service } = makeService(query);

    await expect(service.getShareData('bad-tok')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns answers (with Number()-coerced values) and completed count', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ session_id: 'sess-7' }]) // SELECT session
      .mockResolvedValueOnce([
        { question_index: 0, answer: '3' },
        { question_index: 1, answer: 4 },
      ]) // SELECT answers
      .mockResolvedValueOnce([{ count: '42' }]); // SELECT completed count
    const { service } = makeService(query);

    const out = await service.getShareData('good-tok');

    expect(out).toEqual({
      answers: [
        { question_index: 0, answer: 3 },
        { question_index: 1, answer: 4 },
      ],
      completed: 42,
    });
  });
});

describe('DashboardService.getCompletedSessionCount', () => {
  it('parses count from the first row', async () => {
    const query = jest.fn().mockResolvedValue([{ count: '17' }]);
    const { service } = makeService(query);

    await expect(service.getCompletedSessionCount()).resolves.toBe(17);
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([5]);
  });

  it('returns 0 when no rows', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { service } = makeService(query);

    await expect(service.getCompletedSessionCount()).resolves.toBe(0);
  });

  it('returns 0 when count field is missing', async () => {
    const query = jest.fn().mockResolvedValue([{}]);
    const { service } = makeService(query);

    await expect(service.getCompletedSessionCount()).resolves.toBe(0);
  });
});
