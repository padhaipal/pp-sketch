# seed-geo-entities.ts / seed-geo-entities.main.ts — geo_entity seed

`seed-geo-entities.ts` is pure: cleaning rules, a pass-1 accumulator and an
orchestrator (`runSeed`) that takes injected I/O (`SeedDeps`) so every rule
is unit-tested over a 60-row fixture without a database
(seed-geo-entities.spec.ts). `seed-geo-entities.main.ts` is the CLI
(istanbul-ignored): it downloads the register, boots a Nest application
context for the DataSource + `GeoEntityService`, and wires real I/O. Runbook:
src/docs/seeding-geo-entities.md.

## Source

One file: `schools_india_with_coords.csv.gz` from the
`DavidChristopherNelson/india-school-coordinates` GitHub release (156 MB,
962 MB uncompressed, 1.73 M rows, 67 columns — see `data/sample_1000.csv`
there). It carries the whole hierarchy (`state_code/state`,
`district_code/district`, `block_code/block`), so every level is derived
from it; no separate hierarchy files. There is no `flag_suspect` column.

Flags: `--pulled-at <ISO>` (required → `source_pulled_at`), `--dry-run`,
`--schools-url` (default the latest release asset), `--manifest` (path or
URL to `boundaries_manifest.csv`; default
`${DASHBOARD_PUBLIC_URL}/boundaries/boundaries_manifest.csv`),
`--status-map` (JSON string or file, merged over `SCHOOL_STATUS_MAP` for
this run).

Download once, stream twice: the gzip is spooled to `/tmp` and piped
through `zlib.createGunzip()` → csv-parse on each pass; the expansion is
never buffered.

## Malformed rows

csv-parse runs with `skip_records_with_error: true` (and
`relax_column_count` at its default): a record with the wrong field count —
a stray unescaped comma — is skipped and counted via the `skip` event, never
a stream error (~108k such rows are expected out of 1.73 M). Backstop for a
stray comma that leaves the count intact: `checkRowFormat` (11-digit
`udise_code`; numeric 2/4/6-digit state/district/block codes; non-blank
name) — failures are skipped and counted separately.

## Pass 1 — validate and report (`Pass1Accumulator`)

Per row: format check → pseudo-state check (`state_code` not in the
manifest's 36 states — KVS/NVS/Navy/IAF central bodies — skipped) → status
mapping (`schoolStatusName` through `SCHOOL_STATUS_MAP`; unmapped values are
collected and fail validation) → accumulate: hierarchy nodes with majority
names / parents / lgd ids, the school-code set (duplicates skipped),
coordinate counts for operational schools, the distinct
`(schoolStatus, schoolStatusName)` and `(schBroadMgmtId, schMgmtDesc)`
pairs, the `clusterCd` length distribution, clusters spanning more than one
block, the mean serialised `attributes` size.

Validation errors (exit 1): a district/block under two parents, a parent
code missing one level up, an unmapped status, a state count that differs
from the manifest, no valid schools. `--dry-run` stops after the report.

## Pass 2 — insert

Order: country (`IN` / India) → states (36) → districts (~781) → blocks →
schools; each level in its own transaction; batches of 5,000 through
`GeoEntityService.upsertBatch` (unnest-based `INSERT … ON CONFLICT (type,
code) DO UPDATE` over every non-key column except `id`, `created_at`,
`deleted_at`; `updated_at = now()`). Parents are resolved by listed parent
column only (`block_code` for a school), never by code prefix — five HP
blocks carry `0212xx` codes under other districts.

**No cluster rows.** A school's `parent_id` is its listed block; a school
whose block was not seeded is skipped and logged. `clusterCd`/`cluster` stay
in `attributes`. Measured on the full register: 358,302 distinct `clusterCd`
values (not the ~85k once assumed); only 81k are clean 10-digit codes —
147k are 7 characters, 123k are 9, with a tail to 186 characters where
names leaked into the code field — and 0.7% of clusters span more than one
block (11,912 schools would be mis-attributed by a majority-block cluster).
The `cluster` enum value exists so the level can be added later.

Per school: `status` from `schoolStatusName`; `management_group` from
`schBroadMgmtId` (1 → government, 3 → private, else other until the dry
run pins 2/4/5/9); `class_from/to` from `classFrm/classTo`, blanks estimated
from `category` (Primary 1–5, Primary with Upper Primary 1–8, Pre-Primary
null) with `attributes.class_range_estimated = true`; coordinates — a
coordinate shared by 4 or more operational schools (upstream: "shares a
coordinate with 3+ others") is a village centroid typed once, so it goes to
`attributes.suspect_lat/lng` and `lat/lng` stay null, otherwise seeded
directly; `has_boundary` true iff `(type, code)` is in the manifest (never
hardcoded; false for blocks and schools); `source` `kys_by_year`
(non-school rows `kys_by_region`).

`attributes` is an allowlist (`SCHOOL_ATTRIBUTE_KEYS`: schoolId,
schIdMerged, clusterCd, cluster, schoolStatus, schoolStatusName,
schBroadMgmtId, schCategoryId, schType, villageId, coord_source, plus the
derived suspect_lat/lng and class_range_estimated) — the full 67 columns
would be ~2.9 GB of jsonb. Non-school rows carry `{}` and an `lgd_code`
(states from `lgdStateId`, blocks from `lgdblockId`) only when every school
under them agrees.

After schools: `merged_into_id` is one set-based UPDATE
(`GeoEntityService.linkMergedSchools`: non-operational schools whose
`schIdMerged` — a 7-digit schoolId, `0`/blank = none — names another
school's `schoolId`; self-references and unresolvable ids fail the join).
Then `findMergeCycleBreaks` over the resulting edges nulls the operational
member of each cycle, or every member when none is operational, and logs.
Chains are kept, not flattened.

Then block label points: `backfillBlockCoords` (backfill-block-coords.prompt.md)
writes each block's geometric median of its located schools — a register
refresh that adds blocks locates them in the same run.

Final check: every school's parent chain reaches `IN` within 5 steps and no
school lacks a parent (recursive CTE); then counts per type/status.

## Logging

Every 100,000 rows per pass; skips per reason; per-level upsert counts;
merge pointers set / nulled; the final per-type/status table.
