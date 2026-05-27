// ioredis opens a real socket on `new Redis(...)`. Mock the class so the
// constructor returns a controllable stub and we can capture init args.
const mockRedisInstance = {
  on: jest.fn(),
  connect: jest.fn(),
  quit: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  ping: jest.fn(),
};
const mockRedisCtor = jest.fn();
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation((...args: unknown[]) => {
    mockRedisCtor(...args);
    return mockRedisInstance;
  });
});

process.env.CACHE_REDIS_URL = 'redis://test-cache:6379';

import { CacheService } from './cache';

function resetInstance(): void {
  mockRedisInstance.on.mockReset();
  mockRedisInstance.connect.mockReset().mockResolvedValue(undefined);
  mockRedisInstance.quit.mockReset().mockResolvedValue('OK');
  mockRedisInstance.get.mockReset();
  mockRedisInstance.set.mockReset().mockResolvedValue('OK');
  mockRedisInstance.del.mockReset().mockResolvedValue(1);
  mockRedisInstance.ping.mockReset();
  mockRedisCtor.mockClear();
}

beforeEach(() => resetInstance());

describe('CacheService — constructor', () => {
  it('initialises ioredis with CACHE_REDIS_URL and lazy/retry-1 options', () => {
    new CacheService();
    expect(mockRedisCtor).toHaveBeenCalledWith(
      'redis://test-cache:6379',
      expect.objectContaining({ lazyConnect: true, maxRetriesPerRequest: 1 }),
    );
  });

  it('registers an "error" handler and kicks off connect() (errors swallowed)', () => {
    mockRedisInstance.connect.mockRejectedValueOnce(new Error('refused'));
    new CacheService();
    expect(mockRedisInstance.on).toHaveBeenCalledWith(
      'error',
      expect.any(Function),
    );
    expect(mockRedisInstance.connect).toHaveBeenCalledTimes(1);
  });

  it('error handler logs (executes without throwing) when ioredis emits "error"', () => {
    new CacheService();
    const handler = mockRedisInstance.on.mock.calls[0][1] as (
      e: Error,
    ) => void;
    expect(() => handler(new Error('boom'))).not.toThrow();
  });
});

describe('CacheService.get', () => {
  it('returns null when the key is missing', async () => {
    mockRedisInstance.get.mockResolvedValue(null);
    const svc = new CacheService();
    await expect(svc.get('k')).resolves.toBeNull();
  });

  it('parses and returns JSON-typed values on a hit', async () => {
    mockRedisInstance.get.mockResolvedValue(JSON.stringify({ a: 1 }));
    const svc = new CacheService();
    await expect(svc.get<{ a: number }>('k')).resolves.toEqual({ a: 1 });
  });

  it('deletes the key and returns null when the cached value is corrupt JSON', async () => {
    mockRedisInstance.get.mockResolvedValue('not-json');
    const svc = new CacheService();

    await expect(svc.get('k')).resolves.toBeNull();
    expect(mockRedisInstance.del).toHaveBeenCalledWith('k');
  });

  it('returns null and swallows the error when redis.get rejects', async () => {
    mockRedisInstance.get.mockRejectedValue(new Error('redis down'));
    const svc = new CacheService();
    await expect(svc.get('k')).resolves.toBeNull();
  });
});

describe('CacheService.set', () => {
  it('stringifies the value and sets EX TTL', async () => {
    const svc = new CacheService();
    await svc.set('k', { a: 1 }, 60);
    expect(mockRedisInstance.set).toHaveBeenCalledWith(
      'k',
      JSON.stringify({ a: 1 }),
      'EX',
      60,
    );
  });

  it('swallows errors from redis.set (best-effort cache write)', async () => {
    mockRedisInstance.set.mockRejectedValue(new Error('OOM'));
    const svc = new CacheService();
    await expect(svc.set('k', { a: 1 }, 60)).resolves.toBeUndefined();
  });
});

describe('CacheService.del', () => {
  it('deletes a single key via varargs', async () => {
    const svc = new CacheService();
    await svc.del('k');
    expect(mockRedisInstance.del).toHaveBeenCalledWith('k');
  });

  it('deletes multiple keys (array → spread)', async () => {
    const svc = new CacheService();
    await svc.del(['a', 'b', 'c']);
    expect(mockRedisInstance.del).toHaveBeenCalledWith('a', 'b', 'c');
  });

  it('is a no-op on an empty array (never calls redis.del)', async () => {
    const svc = new CacheService();
    await svc.del([]);
    expect(mockRedisInstance.del).not.toHaveBeenCalled();
  });

  it('swallows errors from redis.del', async () => {
    mockRedisInstance.del.mockRejectedValue(new Error('redis down'));
    const svc = new CacheService();
    await expect(svc.del('k')).resolves.toBeUndefined();
  });
});

describe('CacheService.isHealthy', () => {
  it('returns true when redis.ping resolves with "PONG"', async () => {
    mockRedisInstance.ping.mockResolvedValue('PONG');
    const svc = new CacheService();
    await expect(svc.isHealthy()).resolves.toBe(true);
  });

  it('returns false when ping resolves with anything other than "PONG"', async () => {
    mockRedisInstance.ping.mockResolvedValue('NOPE');
    const svc = new CacheService();
    await expect(svc.isHealthy()).resolves.toBe(false);
  });

  it('returns false when ping rejects', async () => {
    mockRedisInstance.ping.mockRejectedValue(new Error('connection refused'));
    const svc = new CacheService();
    await expect(svc.isHealthy()).resolves.toBe(false);
  });

  it('returns false when the 5s ping deadline elapses (timeout branch)', async () => {
    jest.useFakeTimers();
    // ping never resolves
    mockRedisInstance.ping.mockReturnValue(new Promise(() => {}));
    const svc = new CacheService();

    const settled = expect(svc.isHealthy()).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(5_001);
    await settled;
    jest.useRealTimers();
  });
});

describe('CacheService.onModuleDestroy', () => {
  it('quits the redis connection', async () => {
    const svc = new CacheService();
    await svc.onModuleDestroy();
    expect(mockRedisInstance.quit).toHaveBeenCalledTimes(1);
  });

  it('swallows errors from quit() (idempotent shutdown)', async () => {
    mockRedisInstance.quit.mockRejectedValue(new Error('already closed'));
    const svc = new CacheService();
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
  });
});
