# Seeding geo_entity on Railway

Populates the `geo_entity` table (country → states → districts → blocks →
schools) from the india-school-coordinates register. Script:
`src/scripts/seed-geo-entities.main.ts` (rules in
`src/scripts/seed-geo-entities.prompt.md`), compiled by `nest build` into
`dist/scripts/`.

## Prerequisites

- The pp-sketch PR containing Migrations A1 (`CreateGeoEntity`) and A2
  (`AddStaffFieldsToUsers`) is deployed — migrations run on `start:prod`.
- The pp-dashboard PR carrying `public/boundaries/` is deployed:
  `--manifest` defaults to `${DASHBOARD_PUBLIC_URL}/boundaries/boundaries_manifest.csv`
  on that host (a local path is accepted for dev).

## Steps

1. `railway link`, select the target environment.
2. `railway ssh --service pp-sketch`.
3. In the container:
   `node dist/scripts/seed-geo-entities.main.js --pulled-at <ISO> --dry-run`.
   Read until "validation passed" and the counts print (rows read, rows
   skipped per reason, counts per level, the distinct
   `(schoolStatus, schoolStatusName)` and `(schBroadMgmtId, schMgmtDesc)`
   pairs, the `clusterCd` length distribution, clusters spanning blocks, the
   mean `attributes` size per school).
4. Fill the status and management mappings from that output and re-run the
   dry run with `--status-map '{"Closed":"closed", …}'` until it passes clean.
   No redeploy needed; pin the values into `SCHOOL_STATUS_MAP` /
   `managementGroup` in a follow-up commit afterwards.
5. Re-run without `--dry-run`. Expect 20–60 minutes; keep the session open,
   or run under `nohup … &` and tail the log.
6. Verify:
   `SELECT type, count(*) FROM geo_entity GROUP BY type;`
   `SELECT count(*) FROM geo_entity WHERE type='school' AND parent_id IS NULL;`
   `SELECT pg_size_pretty(pg_total_relation_size('geo_entity'));`

`--pulled-at` is the register's pull timestamp (written to
`source_pulled_at` on every row). `--schools-url` overrides the release
asset (default: the latest `schools_india_with_coords.csv.gz`).

## Notes

The container has curl and outbound network and sits on Railway's private
network next to Postgres, so both the download and the inserts are fast. If
`railway ssh` is missing from your CLI version, upgrade it rather than
falling back to `railway run`, which executes locally and pushes every
insert over the public TCP proxy.

Check the Railway Postgres disk allocation against the expected `geo_entity`
size before the real run (the dry run prints the mean `attributes` size per
school; × ~1.7 M schools, plus indexes).

Seed staging first. The prod→staging mirror (`src/mirror`) overwrites
staging when it runs, so confirm its actual trigger — verify whether it is
scheduled at all — before relying on staging data.

Re-running is safe: every level upserts on `(type, code)` and never touches
`id`, `created_at` or `deleted_at`, so soft-deleted entities stay deleted.
