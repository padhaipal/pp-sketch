See src/docs/database.md for redis/database details and fallback patterns.
Inject CacheService from src/interfaces/redis/cache.ts. See cache.dto for key builders and TTLs.

## DB access pattern
Uses TypeORM Repository API (`@InjectRepository(UserEntity)`) for simple CRUD (find, save, remove).
Uses raw SQL via `DataSource.query()` only for:
- Recursive CTE cycle detection (referral chain check in create/update)
- INSERT...SELECT with referrer lookup by external_id (create with referrer_external_id)
Do NOT use `DataSource.query()` for simple reads/writes — use the Repository.

find(options: FindUserOptions): Promise<User | null>
* Validate options at runtime with validateFindUserOptions(). If it fails, log WARN and let the BadRequestException propagate.
* Determine the cache key: if options.id is provided, use CACHE_KEYS.userById(options.id). If options.external_id is provided, use CACHE_KEYS.userByExternalId(options.external_id).
* Call cacheService.get<User>(key).
  * If cache hit: return the cached user.
* Query the database for one user by id or external_id.
* If found: populate the cache for BOTH keys (userById and userByExternalId) with CACHE_TTL.USER so future lookups by either identifier hit the cache.
* Return the user entity or null if not found.

update(options: UpdateUserOptions): Promise<User | null>
* Validate options at runtime with validateUpdateUserOptions(). If it fails, log WARN and let the BadRequestException propagate.
* One query to find and update the user. After write, if a referrer was set (i.e. new_referrer_user_id or new_referrer_external_id was provided and resolves to a non-null UUID): run a cycle check before committing — execute the following recursive CTE and if it returns any rows, roll back and throw BadRequestException:
  ```sql
  WITH RECURSIVE chain AS (
    SELECT id, referrer_user_id FROM users WHERE id = $resolved_referrer_id
    UNION ALL
    SELECT u.id, u.referrer_user_id FROM users u
    JOIN chain c ON u.id = c.referrer_user_id
    WHERE c.referrer_user_id IS NOT NULL
  )
  SELECT 1 FROM chain WHERE id = $current_user_id
  ```
* Updatable fields:
  * new_external_id replaces the user's external_id, discarding the old one.
  * new_name sets the user's name (optional display name).
  * new_referrer_user_id sets the user's referrer_user_id directly by UUID (pass null to remove the referral).
  * new_referrer_external_id looks up the referrer by external_id and sets referrer_user_id to the found user's id.
  * Only one of new_referrer_user_id/new_referrer_external_id may be provided. Can be combined with new_external_id or new_name.
* If the user was found and updated: invalidate the cache. Delete all keys that might reference stale data:
  * CACHE_KEYS.userById(updatedUser.id)
  * CACHE_KEYS.userByExternalId(updatedUser.external_id) — the NEW external_id
  * If new_external_id was provided (external_id changed): also delete CACHE_KEYS.userByExternalId(options.external_id) — the OLD external_id used to identify the user.
  Then populate the cache with the fresh entity for both userById and userByExternalId keys with CACHE_TTL.USER.
* Return the updated user entity, or null if the user was not found.

create(options: CreateUserOptions): Promise<User>
* Validate options at runtime with validateCreateUserOptions(). If it fails, log WARN and let the BadRequestException propagate.
* One atomic query to create the user and resolve the referrer (if provided). After write, if a referrer was set: run the same recursive CTE cycle check as in update() — if it returns any rows, roll back and throw BadRequestException.
* Populate the cache for both userById and userByExternalId keys with CACHE_TTL.USER.
* Return the newly created user entity.

## getLiteracyTestScores (2026-07, reworked 2026-08)

Digital-proxy literacy test scores:
- NIPUN g1 (unchanged rolling window): last 2 level-8 sentence FIRST read
  attempts (success = the `…-sentence-comprehension-correct-first` stid;
  drill/wrong-retry rows are the failures; retry successes never count).
- Everything else counts only a student's FIRST attempt per question (deduped
  by question id — after seeing the explanation, repeats are invalidated).
  The question's level is its passage's media_details.level; level 13 never
  qualifies. Question types are the reading subconstructs R1.1-R3.2.
- NIPUN g2: 4 most recent level-10 R1.1/R1.2/R1.3 first attempts.
- NIPUN g3: 4 most recent level-11/12 R1.1/R1.2/R1.3 first attempts.
- MPL-B: 20 level-11/12 first attempts selected by four filters walking
  most-recent-first — (1) pool < 20 → insufficient; (2) one per distinct
  type until 4 types (≤3 distinct types → insufficient); (3) batch quotas
  R1.x ×5, R2.x ×5, R3.x ×1 (filter-2 picks count); (4) fill to 20.
- Snapshot tests score correct/selected, pass STRICTLY > 0.5, and return
  history[] = the snapshot replayed over every chronological prefix
  (insufficient prefixes skipped); latest = final history entry.
Question types/levels come from media_details on the option's question row
and its parent passage row (complex queries #1/#2 in the method). Exposed
at GET /users/:id/literacy-test-scores.
