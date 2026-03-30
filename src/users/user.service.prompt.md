See src/docs/database.md for redis/database details and fallback patterns.
Inject CacheService from src/interfaces/redis/cache.ts. See cache.dto for key builders and TTLs.

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
  Skip the cycle check entirely if no referrer was provided or if the referrer value resolves to null (removal).
* Updatable fields:
  * new_external_id replaces the user's external_id, discarding the old one.
  * new_referrer_user_id sets the user's referrer_user_id directly by UUID (pass null to remove the referral).
  * new_referrer_external_id looks up the referrer by external_id and sets referrer_user_id to the found user's id.
  * Only one of new_referrer_user_id/new_referrer_external_id may be provided. Can be combined with new_external_id.
* If the user was found and updated: invalidate the cache. Delete all keys that might reference stale data:
  * CACHE_KEYS.userById(updatedUser.id)
  * CACHE_KEYS.userByExternalId(updatedUser.external_id) — the NEW external_id
  * If new_external_id was provided (external_id changed): also delete CACHE_KEYS.userByExternalId(options.external_id) — the OLD external_id used to identify the user.
  Then populate the cache with the fresh entity for both userById and userByExternalId keys with CACHE_TTL.USER.
* Return the updated user entity, or null if the user was not found.

create(options: CreateUserOptions): Promise<User>
* Validate options at runtime with validateCreateUserOptions(). If it fails, log WARN and let the BadRequestException propagate.
* One atomic query to create the user and resolve the referrer (if provided). After write, if a referrer was set: run the same recursive CTE cycle check as in update() — if it returns any rows, roll back and throw BadRequestException. Skip the cycle check if no referrer was provided.
* Populate the cache for both userById and userByExternalId keys with CACHE_TTL.USER.
* Return the newly created user entity.
