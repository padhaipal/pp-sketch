# geo-entity.service.ts — reads for the staff endpoints, writes for the seed

Raw SQL over `DataSource` (reads inline per repo convention; every write to
`geo_entity` lives here — the seed script calls these, never SQL of its own).

- `getById(id)`, `getByCode(type, code)` — one row or null, deleted rows
  included (callers decide).
- `ancestors(id)` — recursive CTE upward, capped at `MAX_ANCESTOR_DEPTH` = 6,
  root (country) first, excluding `id`. Deleted ancestors are returned: a
  teacher's school must still resolve its district.
- `descendants(id, type, {cursor?, limit})` — recursive CTE downward that
  stops expanding once it reaches `type` (a block's schools are one hop);
  `status = 'operational' AND deleted_at IS NULL`; keyset-paged by id
  (`next_cursor` = last id when a further page exists; asks for limit + 1).
- `search(q, type?, limit = 20)` — `name ILIKE %q%` or `code LIKE q%` (LIKE
  metacharacters escaped), operational, not deleted, ordered by type (enum
  order — country first) then name; `[]` for a blank query.
- `codeMap(type)` — code → id for one level (the seed resolves parents).

Seed writes:

- `upsertBatch(rows, manager?)` — one unnest-based
  `INSERT … ON CONFLICT (type, code) DO UPDATE` (15 bind parameters however
  many rows, so 5,000-row batches stay under Postgres's 65,535 limit).
  Overwrites every non-key column except `id`, `created_at`, `deleted_at`;
  sets `updated_at = now()`. For `type = 'block'` rows only, `lat`/`lng` are
  `COALESCE(EXCLUDED.x, geo_entity.x)` — block coordinates are computed
  afterwards (backfill-block-coords.ts), so a re-seed carrying nulls must
  not wipe them; schools and every other level overwrite. `manager` runs it
  inside the caller's transaction.
- `updateBlockCoordinates(id, lat, lng, manager?)` — the block label point
  write (blocks only).
- `linkMergedSchools()` — set-based UPDATE joining `attributes->>'schIdMerged'`
  to another school's `attributes->>'schoolId'` for non-operational schools
  (never self, never `''`/`'0'`); returns the count.
- `mergeEdges()` / `clearMergedInto(ids)` — the merged_into graph for cycle
  breaking, and the null-out.
