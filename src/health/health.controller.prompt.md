// pp-sketch/src/health/health.controller.prompt.md

// GET /health
// Returns the health status of all critical dependencies.
// No authentication required — used by Railway for deployment health checks.

// Swagger: @ApiTags('health')

check()
1.) Run the following checks in parallel:
  * **pg**: Execute `SELECT 1` via TypeORM DataSource (`this.dataSource.query('SELECT 1')`). Pass if it returns within 5 seconds, fail otherwise.
  * **redis_queue**: Execute `PING` against the BullMQ Redis connection (REDIS_URL, from src/interfaces/redis/queues.ts). Pass if it returns `PONG` within 5 seconds, fail otherwise.
  * **redis_cache**: Call `cacheService.isHealthy()` (CACHE_REDIS_URL, from src/interfaces/redis/cache.ts). Pass if it returns true, fail otherwise.

2.) Build the response body:
  {
    status: 'ok' | 'degraded',       // 'ok' if all checks passed, 'degraded' if any failed
    checks: {
      pg: { status: 'up' | 'down', latency_ms: number },
      redis_queue: { status: 'up' | 'down', latency_ms: number },
      redis_cache: { status: 'up' | 'down', latency_ms: number },
    },
    uptime_ms: process.uptime() * 1000,
  }

3.) Return 200 if status is 'ok'. Return 503 if status is 'degraded'.
