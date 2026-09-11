# geo-entity.dto.ts — geo_entity types and validators

`geo_entity` is the administrative geography for the education-official
product: one row per country / state / district / block / school
(`GEO_ENTITY_TYPES`; `cluster` is in the enum but never seeded — see
src/scripts/seed-geo-entities.prompt.md), parent-linked through `parent_id`.
Migration: `1787000000000-CreateGeoEntity` (enums `geo_entity_type`,
`geo_entity_status`, `management_group`; `UNIQUE (type, code)`; indexes on
`parent_id`, `(type, status)`, `merged_into_id`, and partial expression
indexes on `attributes->>'clusterCd'` and `attributes->>'schoolId'` for
schools).

Columns: `code` (UDISE code: 2-digit state, 4-digit district, 6-digit block,
11-digit school; `IN` for the country), `name`, `lgd_code`, `lat/lng`
(null for a village-centroid school — the typed value sits in
`attributes.suspect_lat/lng`), `has_boundary` (true iff the dashboard ships
a GeoJSON for it — only states, districts and the country), `status`
(`GEO_ENTITY_STATUSES`, non-school rows are always `operational`),
`merged_into_id` (non-operational school → the school it merged into),
`management_group`, `class_from/to`, `attributes` (allowlisted source
columns), `source` (`kys_by_year` schools / `kys_by_region` others),
`source_pulled_at`, `deleted_at` (soft delete; re-seeds never resurrect).

`DEFAULT_ROLE_TITLE_BY_TYPE` — the role title a staff account gets by
default per entity type (school → Teacher, block → BEO, district → BSA,
state → DGSE, country → Minister); the dashboard's /onboarding form prefills
from the same map.

Response shapes: `GeoEntitySearchRow` (search), `DescendantsPage` /
`GeoEntityDescendantRow` (descendants, keyset cursor = last id, limit ≤
`DESCENDANTS_MAX_LIMIT` = 500, default 100), `GeoEntityUpsertRow` (what the
seed writes). Validators throw BadRequestException: `validateGeoEntityType`,
`validateGeoEntityId(value, field)`, `validateDescendantsLimit`.
