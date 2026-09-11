## Infrastructure services

* **pp-db** — Railway-deployed PostgreSQL database. The primary data store for all application state.
* **pp-redis-cache** — Railway-deployed Redis instance used exclusively for read-through caching of PG data. Connection: `CACHE_REDIS_URL` (.env). See `src/interfaces/redis/cache.prompt.md`.
* **pp-redis-queue** — Railway-deployed Redis instance used exclusively by BullMQ for job queues. Connection: `BULLMQ_REDIS_URL` (.env). See `src/interfaces/redis/queues.prompt.md`.
* **media-bucket** — Railway-deployed S3-compatible object store for audio/video/image files.

The two Redis instances are intentionally separate so that cache eviction or memory pressure on one does not affect the other.

## DB access pattern

Simple CRUD uses TypeORM Repository API (`@InjectRepository`, `Repository<Entity>`, `findOneBy`, `find`, `save`, `update`, `delete`). Complex queries (PL/pgSQL blocks, recursive CTEs, INSERT...SELECT with guards, multi-CTE word selection, bulk INSERT via UNION ALL) use raw SQL via `DataSource.query()`.

Services that need both inject `Repository<Entity>` for CRUD and `DataSource` for raw SQL. BullMQ processors receive `Repository<Entity>` from `main.ts` via `dataSource.getRepository()`.

Each service's `.prompt.md` documents which of its queries use Repository vs raw SQL.

## Database fallback

* If pp-redis-cache is down: log WARN and read directly from PG. Cache writes are silently skipped. See `src/interfaces/redis/cache.prompt.md` for the fallback implementation.
* If PG is down: log ERROR. The operation fails — there is no secondary data store.

## Migrations — transaction mode

`migration:run` / `migration:run:prod` pass `-t each`: every pending
migration runs in its own transaction (TypeORM's default `all` mode wraps
the whole batch in one and REFUSES any migration that sets its own
`transaction` flag). A migration that must run outside a transaction — e.g.
CascadeUserDeletes, which adds foreign keys as `NOT VALID` and then
`VALIDATE CONSTRAINT`s them so the scan takes only SHARE UPDATE EXCLUSIVE —
sets `transaction = false` on its class and must be idempotent step by step
(DROP IF EXISTS before ADD), since a mid-way failure leaves partial state
that is simply re-run. Consequence of `each`: an earlier migration in a
batch stays committed if a later one fails.
