// Mock the queues module — its module-load side effect opens a real Redis
// socket, which we never want in unit tests.
const mockPing = jest.fn();
jest.mock('../interfaces/redis/queues', () => ({
  queueRedisConnection: { ping: (...args: unknown[]) => mockPing(...args) },
  QUEUE_NAMES: {},
  DEFAULT_JOB_OPTIONS: {},
  createQueue: jest.fn(),
  createWorker: jest.fn(),
}));

import { HttpStatus } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthController } from './health.controller';
import { CacheService } from '../interfaces/redis/cache';

type ResLike = {
  status: jest.Mock;
  json: jest.Mock;
};

function makeRes(): ResLike {
  const res: ResLike = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function makeDataSource(query: jest.Mock): DataSource {
  return { query } as unknown as DataSource;
}

function makeCache(isHealthy: jest.Mock): CacheService {
  return { isHealthy } as unknown as CacheService;
}

describe('HealthController.check', () => {
  beforeEach(() => {
    mockPing.mockReset();
  });

  it('returns 200 + status=ok when all checks pass', async () => {
    const ds = makeDataSource(jest.fn().mockResolvedValue([{ '?column?': 1 }]));
    const cache = makeCache(jest.fn().mockResolvedValue(true));
    mockPing.mockResolvedValue('PONG');

    const controller = new HealthController(ds, cache);
    const res = makeRes();
    await controller.check(res as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('ok');
    expect(body.checks.pg.status).toBe('up');
    expect(body.checks.redis_queue.status).toBe('up');
    expect(body.checks.redis_cache.status).toBe('up');
    expect(typeof body.uptime_ms).toBe('number');
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(typeof body.checks.pg.latency_ms).toBe('number');
  });

  it('returns 503 + degraded when pg query rejects', async () => {
    const ds = makeDataSource(jest.fn().mockRejectedValue(new Error('boom')));
    const cache = makeCache(jest.fn().mockResolvedValue(true));
    mockPing.mockResolvedValue('PONG');

    const controller = new HealthController(ds, cache);
    const res = makeRes();
    await controller.check(res as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('degraded');
    expect(body.checks.pg.status).toBe('down');
    expect(body.checks.redis_queue.status).toBe('up');
    expect(body.checks.redis_cache.status).toBe('up');
  });

  it('marks redis_queue down when ping returns a value other than PONG', async () => {
    const ds = makeDataSource(jest.fn().mockResolvedValue([{ '?column?': 1 }]));
    const cache = makeCache(jest.fn().mockResolvedValue(true));
    mockPing.mockResolvedValue('NOPE');

    const controller = new HealthController(ds, cache);
    const res = makeRes();
    await controller.check(res as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    const body = res.json.mock.calls[0][0];
    expect(body.checks.redis_queue.status).toBe('down');
    expect(body.status).toBe('degraded');
  });

  it('marks redis_queue down when ping rejects', async () => {
    const ds = makeDataSource(jest.fn().mockResolvedValue([{ '?column?': 1 }]));
    const cache = makeCache(jest.fn().mockResolvedValue(true));
    mockPing.mockRejectedValue(new Error('conn refused'));

    const controller = new HealthController(ds, cache);
    const res = makeRes();
    await controller.check(res as never);

    const body = res.json.mock.calls[0][0];
    expect(body.checks.redis_queue.status).toBe('down');
    expect(body.status).toBe('degraded');
  });

  it('marks redis_cache down when CacheService.isHealthy returns false', async () => {
    const ds = makeDataSource(jest.fn().mockResolvedValue([{ '?column?': 1 }]));
    const cache = makeCache(jest.fn().mockResolvedValue(false));
    mockPing.mockResolvedValue('PONG');

    const controller = new HealthController(ds, cache);
    const res = makeRes();
    await controller.check(res as never);

    const body = res.json.mock.calls[0][0];
    expect(body.checks.redis_cache.status).toBe('down');
    expect(body.status).toBe('degraded');
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('reports all three downs together when every dependency fails', async () => {
    const ds = makeDataSource(jest.fn().mockRejectedValue(new Error('x')));
    const cache = makeCache(jest.fn().mockResolvedValue(false));
    mockPing.mockRejectedValue(new Error('y'));

    const controller = new HealthController(ds, cache);
    const res = makeRes();
    await controller.check(res as never);

    const body = res.json.mock.calls[0][0];
    expect(body.checks.pg.status).toBe('down');
    expect(body.checks.redis_queue.status).toBe('down');
    expect(body.checks.redis_cache.status).toBe('down');
    expect(body.status).toBe('degraded');
  });

  it('returns down for pg when its query exceeds the 5s timeout', async () => {
    jest.useFakeTimers();
    let resolvePg: (v: unknown) => void = () => {};
    const pgPromise = new Promise((res) => {
      resolvePg = res;
    });
    const ds = makeDataSource(jest.fn().mockReturnValue(pgPromise));
    const cache = makeCache(jest.fn().mockResolvedValue(true));
    mockPing.mockResolvedValue('PONG');

    const controller = new HealthController(ds, cache);
    const res = makeRes();
    const done = controller.check(res as never);

    // Advance past the 5s timeout in the controller.
    await jest.advanceTimersByTimeAsync(5001);
    // Drain the still-pending query so jest doesn't leak it.
    resolvePg([{ '?column?': 1 }]);
    await done;

    const body = res.json.mock.calls[0][0];
    expect(body.checks.pg.status).toBe('down');
    jest.useRealTimers();
  });
});
