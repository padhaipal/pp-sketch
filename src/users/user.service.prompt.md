See src/docs/database.md for redis/database details and fallback patterns.
Inject CacheService from src/interfaces/redis/cache.ts. See cache.dto for key builders and TTLs.

## DB access pattern

Uses TypeORM Repository API (`@InjectRepository(UserEntity)`) for simple CRUD (find, save, remove).
Uses raw SQL via `DataSource.query()` only for:

- Recursive CTE cycle detection (referral chain check in create/update)
- INSERT...SELECT with referrer lookup by external_id (create with referrer_external_id)
  Do NOT use `DataSource.query()` for simple reads/writes — use the Repository.

find(options: FindUserOptions): Promise<User | null>

- Validate options at runtime with validateFindUserOptions(). If it fails, log WARN and let the BadRequestException propagate.
- Determine the cache key: if options.id is provided, use CACHE_KEYS.userById(options.id). If options.external_id is provided, use CACHE_KEYS.userByExternalId(options.external_id).
- Call cacheService.get<User>(key).
  - If cache hit: return the cached user.
- Query the database for one user by id or external_id.
- If found: populate the cache for BOTH keys (userById and userByExternalId) with CACHE_TTL.USER so future lookups by either identifier hit the cache.
- Return the user entity or null if not found.

update(options: UpdateUserOptions, manager?: EntityManager): Promise<User | null>

- Validate options at runtime with validateUpdateUserOptions(). If it fails, log WARN and let the BadRequestException propagate.
- `manager` (optional) runs the whole update inside the caller's transaction: the user is read and saved through `manager.getRepository(UserEntity)` and the cycle check runs through `manager.query`. In that mode the cache is ONLY evicted, never repopulated (a set before commit would publish uncommitted columns), and the caller must call `invalidateCache(user)` after its commit to close the repopulate race. OnboardingService.handleTurn is the caller.
- One query to find and update the user. After write, if a referrer was set (i.e. new_referrer_user_id or new_referrer_external_id was provided and resolves to a non-null UUID): run a cycle check before committing — execute the following recursive CTE and if it returns any rows, roll back and throw BadRequestException:
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
- Updatable fields:
  - new_external_id replaces the user's external_id, discarding the old one.
  - new_name sets the user's name (optional display name).
  - new_referrer_user_id sets the user's referrer_user_id directly by UUID (pass null to remove the referral).
  - new_referrer_external_id looks up the referrer by external_id and sets referrer_user_id to the found user's id.
  - new_birth_year (integer | null), new_birth_month (1–12 | null), new_recording_permissions_obtained_at (Date | null) — the parent-onboarding columns; null clears them (OnboardingService.rollback of a done turn).
  - Only one of new_referrer_user_id/new_referrer_external_id may be provided. Any of the fields can be combined.
- If the user was found and updated: invalidate the cache. Delete all keys that might reference stale data:
  - CACHE_KEYS.userById(updatedUser.id)
  - CACHE_KEYS.userByExternalId(updatedUser.external_id) — the NEW external_id
  - If new_external_id was provided (external_id changed): also delete CACHE_KEYS.userByExternalId(options.external_id) — the OLD external_id used to identify the user.
    Then (no manager only) populate the cache with the fresh entity for both userById and userByExternalId keys with CACHE_TTL.USER.
- Return the updated user entity, or null if the user was not found.

invalidateCache({ id, external_id }): Promise<void>

- Evicts CACHE_KEYS.userById and CACHE_KEYS.userByExternalId. For callers that wrote through update(…, manager), after their transaction commits.

isOnboarded(user: User): boolean

- The parent-onboarding gate (src/onboarding/onboarding.service.prompt.md). Pure — no I/O; reads the user object the caller already holds (which may be a Redis copy, so `created_at` is re-wrapped in `new Date()`). True if ANY of:
  - `role` is non-null and not `'student'` (admin/dev accounts never onboard);
  - `new Date(user.created_at) < ONBOARDING_CUTOFF` (required env, ISO timestamp — `onboardingCutoff()` in src/onboarding/onboarding.config.ts throws if unset/unparseable; validated at bootstrap);
  - `birth_year` AND `recording_permissions_obtained_at` are both non-null (written together when the onboarding machine reaches `done`).

delete(input: string | string[]): Promise<{ deleted, failed }>

- Per user, one transaction: SELECT the user's media `s3_key`s → evict both cache keys (throwOnError: a Redis outage aborts the user, since the post-commit eviction could not be guaranteed either) → `UPDATE users SET referrer_user_id = NULL WHERE referrer_user_id = $1 RETURNING id, external_id` → `DELETE FROM users WHERE id = $1 RETURNING id` (0 rows → NotFoundException, surfaced as `failed`). Everything else hanging off the user — media_metadata (and its transcripts via input_media_id), scores, literacy_lesson_states, onboarding_states, outbound_messages — goes via ON DELETE CASCADE (CascadeUserDeletes migration; src/interfaces/database/migrations/foreign-keys.spec.ts enforces which FKs cascade). Post-commit, best effort: delete each S3 key, evict the user's cache keys again, evict each nulled referrer's cache keys.

create(options: CreateUserOptions): Promise<User>

- Validate options at runtime with validateCreateUserOptions(). If it fails, log WARN and let the BadRequestException propagate.
- One atomic query to create the user and resolve the referrer (if provided). After write, if a referrer was set: run the same recursive CTE cycle check as in update() — if it returns any rows, roll back and throw BadRequestException.
- Populate the cache for both userById and userByExternalId keys with CACHE_TTL.USER.
- Return the newly created user entity.

## getLiteracyTestScores (2026-07, reworked 2026-08)

NOTE (2026-08): the comprehension first-attempts query's three
media_metadata joins (option o → question q → passage p) deliberately carry
NO rolled_back filter — a retroactively quality-culled passage must not
erase a student's already-earned comprehension history (NIPUN grades 2/3,
MPL-B).

Digital-proxy literacy test scores:

- Every test counts only a student's FIRST attempt per question (deduped
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
  and its parent passage row (the comprehension query in the method). Exposed
  at GET /users/:id/literacy-test-scores.
