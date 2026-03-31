// pp-sketch/src/interfaces/redis/cache.prompt.md

// Read-through cache service backed by the pp-redis-cache Redis instance.
// This is a SEPARATE Redis instance from the BullMQ queue Redis (BULLMQ_REDIS_URL).
// Environment variable: CACHE_REDIS_URL (.env).
//
// See src/interfaces/redis/cache.dto.prompt.md for key conventions and TTL defaults.
// See src/docs/database.md for fallback behaviour.

// --- Connection ---

// Create a single ioredis client from CACHE_REDIS_URL (.env).
// Enable lazyConnect so the app starts even if cache Redis is temporarily unreachable.
// Attach an 'error' listener that logs WARN (never crashes the process).

// --- Fallback behaviour ---
// Every public method wraps its Redis call in try/catch.
//   * On Redis error (connection down, timeout, etc.): log WARN and return the
//     "miss" value (null for get, void for set/del). The calling service then
//     falls through to PG via TypeORM DataSource. This matches the database.md contract:
//     "If redis is down then log a WARN and query via TypeORM DataSource directly."
//   * On serialization error (corrupt JSON): log WARN, delete the bad key, return null.

// --- API ---

get<T>(key: string): Promise<T | null>
* Call `redis.get(key)`.
* If null (cache miss or Redis down): return null.
* JSON.parse the result. If parse fails: log WARN, call `del(key)`, return null.
* Return the parsed value cast to T.

set(key: string, value: unknown, ttl_seconds: number): Promise<void>
* JSON.stringify the value.
* Call `redis.set(key, json, 'EX', ttl_seconds)`.
* On error: log WARN, return (no throw).

del(keys: string | string[]): Promise<void>
* Normalise to array.
* If empty: return immediately.
* Call `redis.del(...keys)`.
* On error: log WARN, return (no throw).

isHealthy(): Promise<boolean>
* Call `redis.ping()` with a 5-second timeout.
* Return true if the response is 'PONG', false otherwise.
* On error: return false (no throw).
