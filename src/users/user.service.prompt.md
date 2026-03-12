See src/docs/database.md for redis/database details and fallback patterns. 

Batch calls are chunked into groups of MAX_USER_BATCH_SIZE (env var, default 100). Each chunk issues one DB query. Results are concatenated in input order. For write operations (update, create), all chunks run inside a single transaction — if any chunk fails, the entire batch is rolled back.

Referrer-referee: each user has at most one referrer; a referrer can have many referees. Before any DB work, topologically sort create/update items so referrers are processed before referees. Reject if the batch contains a cycle (e.g. A refs B, B refs A). If a cycle would form with existing DB data, it can only be detected during/after the write — roll back the transaction and reject the call.

find(options: FindUserOptions): Promise<User | null>
find(options: FindUserOptions[]): Promise<(User | null)[]>
* Validate options at runtime with validateFindUserOptions() sequentially. If any fails, log WARN and let the BadRequestException propagate.
* Single: query the database for one user by id or external_id.
* Batch: collect all ids and external_ids, issue one query with WHERE id IN (...) OR external_id IN (...). Map results back to input order, null for any not found.
* Return the user entity (or null) per input.

update(options: UpdateUserOptions): Promise<User | null>
update(options: UpdateUserOptions[]): Promise<(User | null)[]>
* Validate options at runtime with validateUpdateUserOptions() sequentially. If any fails, log WARN and let the BadRequestException propagate.
* Before DB: topologically sort items that set referrer (by new_referrer_user_id or new_referrer_external_id). Reject if cycle within batch.
* Single: one query to find and update the user. After write, if referrer was set, check for cycle with existing data; if detected, roll back and throw.
* Batch: process in sorted order. After each chunk (or at commit), validate no cycle introduced with existing data; if detected, roll back and throw. Map results back to input order, null for any not found.
* Updatable fields:
  * new_external_id replaces the user's external_id, discarding the old one.
  * new_referrer_user_id sets the user's referrer_user_id directly by UUID (pass null to remove the referral).
  * new_referrer_external_id looks up the referrer by external_id and sets referrer_user_id to the found user's id.
  * Only one of new_referrer_user_id/new_referrer_external_id may be provided. Can be combined with new_external_id.
* Return the updated user entity (or null) per input.

create(options: CreateUserOptions): Promise<User>
create(options: CreateUserOptions[]): Promise<User[]>
* Validate options at runtime with validateCreateUserOptions() sequentially. If any fails, log WARN and let the BadRequestException propagate.
* Before DB: topologically sort by referrer dependency (referee depends on referrer). Reject if cycle within batch.
* Single: one atomic query to create the user and resolve the referrer. After write, if referrer was set, check for cycle with existing data; if detected, roll back and throw.
* Batch: process in sorted order. All chunks run inside a single transaction, so users created in an earlier chunk are visible to later chunks. Each chunk inserts its users and resolves referrer_external_ids/referrer_user_ids. After each chunk (or at commit), validate no cycle introduced with existing data; if detected, roll back and throw. Map results back to input order.
* Return the newly created user entity per input.
