import {
  Controller,
  Get,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { queueRedisConnection } from '../interfaces/redis/queues';
import { CacheService } from '../interfaces/redis/cache';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cacheService: CacheService,
  ) {}

  @Get()
  async check(@Res() res: Response) {
    const checks: Record<
      string,
      { status: 'up' | 'down'; latency_ms: number }
    > = {};

    const timeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), ms),
        ),
      ]);

    // PG check
    const pgStart = Date.now();
    try {
      await timeout(this.dataSource.query('SELECT 1'), 5000);
      checks.pg = {
        status: 'up',
        latency_ms: Date.now() - pgStart,
      };
    } catch {
      checks.pg = {
        status: 'down',
        latency_ms: Date.now() - pgStart,
      };
    }

    // Redis queue check
    const rqStart = Date.now();
    try {
      const pong = await timeout(queueRedisConnection.ping(), 5000);
      checks.redis_queue = {
        status: pong === 'PONG' ? 'up' : 'down',
        latency_ms: Date.now() - rqStart,
      };
    } catch {
      checks.redis_queue = {
        status: 'down',
        latency_ms: Date.now() - rqStart,
      };
    }

    // Redis cache check
    const rcStart = Date.now();
    const cacheHealthy = await this.cacheService.isHealthy();
    checks.redis_cache = {
      status: cacheHealthy ? 'up' : 'down',
      latency_ms: Date.now() - rcStart,
    };

    const allUp = Object.values(checks).every(
      (c) => c.status === 'up',
    );
    const status = allUp ? 'ok' : 'degraded';

    const body = {
      status,
      checks,
      uptime_ms: process.uptime() * 1000,
    };

    res
      .status(allUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json(body);
  }
}
