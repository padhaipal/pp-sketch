import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis(process.env.CACHE_REDIS_URL!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', (err) => {
      this.logger.warn(`Cache Redis error: ${err.message}`);
    });
    this.redis.connect().catch(() => {});
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => {});
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        this.logger.warn(`Corrupt cache value for key ${key}, deleting`);
        await this.del(key);
        return null;
      }
    } catch (err) {
      this.logger.warn(
        `Cache get failed for key ${key}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  async set(key: string, value: unknown, ttl_seconds: number): Promise<void> {
    try {
      const json = JSON.stringify(value);
      await this.redis.set(key, json, 'EX', ttl_seconds);
    } catch (err) {
      this.logger.warn(
        `Cache set failed for key ${key}: ${(err as Error).message}`,
      );
    }
  }

  async del(keys: string | string[]): Promise<void> {
    const arr = Array.isArray(keys) ? keys : [keys];
    if (arr.length === 0) return;
    try {
      await this.redis.del(...arr);
    } catch (err) {
      this.logger.warn(`Cache del failed: ${(err as Error).message}`);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const result = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('ping timeout')), 5000),
        ),
      ]);
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}
