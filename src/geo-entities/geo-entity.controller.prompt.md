# geo-entity.controller.ts — GET /geo-entities/\*

Read-only, reached only through the pp-dashboard proxy (NextAuth admin/dev;
the three paths are on its allowlist). No auth on pp-sketch itself, like the
other controllers.

- `GET /geo-entities/search?q=&type=` → `GeoEntitySearchRow[]`
  (`{id,type,code,name,status,parent_name}`). `type` optional (validated
  against `GEO_ENTITY_TYPES` when given); blank `q` → `[]`.
- `GET /geo-entities/:id` → the entity plus `ancestors[]` (root first). 400
  for a non-uuid, 404 when unknown.
- `GET /geo-entities/:id/descendants?type=&cursor=&limit=` →
  `{items:[{id,code,name,has_boundary,lat,lng,status}], next_cursor}`.
  `type` required; `cursor` a uuid when given; `limit` 1–500 (default 100).
  404 when the root does not exist.
