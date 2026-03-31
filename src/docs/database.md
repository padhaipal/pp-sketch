## Infrastructure services

* **pp-db** — Railway-deployed PostgreSQL database. The primary data store for all application state.
* **pp-redis-cache** — Railway-deployed Redis instance used exclusively for read-through caching of PG data. Connection: `CACHE_REDIS_URL` (.env). See `src/interfaces/redis/cache.prompt.md`.
* **pp-redis-queue** — Railway-deployed Redis instance used exclusively by BullMQ for job queues. Connection: `BULLMQ_REDIS_URL` (.env). See `src/interfaces/redis/queues.prompt.md`.
* **media-bucket** — Railway-deployed S3-compatible object store for audio/video/image files.

The two Redis instances are intentionally separate so that cache eviction or memory pressure on one does not affect the other.

## Database fallback

* If pp-redis-cache is down: log WARN and read directly from PG. Cache writes are silently skipped. See `src/interfaces/redis/cache.prompt.md` for the fallback implementation.
* If PG is down: log ERROR. The operation fails — there is no secondary data store.
