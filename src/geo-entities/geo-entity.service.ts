import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  DescendantsPage,
  GeoEntity,
  GeoEntityDescendantRow,
  GeoEntitySearchRow,
  GeoEntityType,
  GeoEntityUpsertRow,
  SEARCH_LIMIT,
} from './geo-entity.dto';

// Ancestor walk cap: country → state → district → block → cluster → school.
export const MAX_ANCESTOR_DEPTH = 6;

export interface MergeEdge {
  id: string;
  merged_into_id: string;
  status: string;
}

// Escapes LIKE metacharacters so a user-typed query is matched literally.
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const UPSERT_COLUMNS = [
  'type',
  'parent_id',
  'code',
  'name',
  'lgd_code',
  'lat',
  'lng',
  'has_boundary',
  'status',
  'management_group',
  'class_from',
  'class_to',
  'attributes',
  'source',
  'source_pulled_at',
] as const;

@Injectable()
export class GeoEntityService {
  private readonly logger = new Logger(GeoEntityService.name);

  constructor(private readonly dataSource: DataSource) {}

  async getById(id: string): Promise<GeoEntity | null> {
    const rows: GeoEntity[] = await this.dataSource.query(
      `SELECT * FROM geo_entity WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async getByCode(
    type: GeoEntityType,
    code: string,
  ): Promise<GeoEntity | null> {
    const rows: GeoEntity[] = await this.dataSource.query(
      `SELECT * FROM geo_entity WHERE type = $1 AND code = $2`,
      [type, code],
    );
    return rows[0] ?? null;
  }

  // Parents of `id`, root (country) first, excluding `id` itself. Deleted
  // ancestors are returned too — a teacher's school must still resolve its
  // district even if the district row was soft-deleted.
  async ancestors(id: string): Promise<GeoEntity[]> {
    const rows: GeoEntity[] = await this.dataSource.query(
      `WITH RECURSIVE up AS (
         SELECT g.*, 1 AS depth
         FROM geo_entity g
         WHERE g.id = (SELECT parent_id FROM geo_entity WHERE id = $1)
         UNION ALL
         SELECT g.*, up.depth + 1
         FROM geo_entity g
         JOIN up ON g.id = up.parent_id
         WHERE up.depth < $2
       )
       SELECT id, type, parent_id, code, name, lgd_code, lat, lng, has_boundary,
              status, merged_into_id, management_group, class_from, class_to,
              attributes, source, source_pulled_at, created_at, updated_at,
              deleted_at
       FROM up
       ORDER BY depth DESC`,
      [id, MAX_ANCESTOR_DEPTH],
    );
    return rows;
  }

  // Operational, non-deleted descendants of `id` of the given type, keyset-
  // paged by id. The recursion stops expanding once it reaches the target
  // type, so a block's schools cost one hop.
  async descendants(
    id: string,
    type: GeoEntityType,
    options: { cursor?: string | null; limit: number },
  ): Promise<DescendantsPage> {
    const { cursor = null, limit } = options;
    const rows: GeoEntityDescendantRow[] = await this.dataSource.query(
      `WITH RECURSIVE tree AS (
         SELECT id, type FROM geo_entity WHERE parent_id = $1
         UNION ALL
         SELECT g.id, g.type
         FROM geo_entity g
         JOIN tree t ON g.parent_id = t.id
         WHERE t.type <> $2
       )
       SELECT g.id, g.code, g.name, g.has_boundary, g.lat, g.lng, g.status
       FROM tree t
       JOIN geo_entity g ON g.id = t.id
       WHERE g.type = $2
         AND g.status = 'operational'
         AND g.deleted_at IS NULL
         AND ($3::uuid IS NULL OR g.id > $3::uuid)
       ORDER BY g.id
       LIMIT $4`,
      [id, type, cursor, limit + 1],
    );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      next_cursor: hasMore ? items[items.length - 1].id : null,
    };
  }

  // Operational, non-deleted entities whose name contains `q` or whose code
  // starts with it; ordered by type (enum order: country first), then name.
  async search(
    q: string,
    type?: GeoEntityType | null,
    limit: number = SEARCH_LIMIT,
  ): Promise<GeoEntitySearchRow[]> {
    const trimmed = q.trim();
    if (trimmed.length === 0) return [];
    const pattern = escapeLike(trimmed);
    const rows: GeoEntitySearchRow[] = await this.dataSource.query(
      `SELECT g.id, g.type, g.code, g.name, g.status, p.name AS parent_name
       FROM geo_entity g
       LEFT JOIN geo_entity p ON p.id = g.parent_id
       WHERE g.status = 'operational'
         AND g.deleted_at IS NULL
         AND ($2::geo_entity_type IS NULL OR g.type = $2::geo_entity_type)
         AND (g.name ILIKE '%' || $1 || '%' ESCAPE '\\'
              OR g.code LIKE $1 || '%' ESCAPE '\\')
       ORDER BY g.type, g.name
       LIMIT $3`,
      [pattern, type ?? null, limit],
    );
    return rows;
  }

  // code → id for one type (the seed resolves parents through this).
  async codeMap(type: GeoEntityType): Promise<Map<string, string>> {
    const rows: { id: string; code: string }[] = await this.dataSource.query(
      `SELECT id, code FROM geo_entity WHERE type = $1`,
      [type],
    );
    return new Map(rows.map((r) => [r.code, r.id]));
  }

  // ─── Seed writes ────────────────────────────────────────────────────────

  // Multi-row upsert keyed on (type, code) via unnest — 15 bind parameters
  // regardless of batch size, so 5,000-row batches stay under Postgres's
  // 65,535-parameter limit. Every non-key column is overwritten except id,
  // created_at and deleted_at (a re-seed must not resurrect a soft-deleted
  // entity); updated_at is bumped.
  async upsertBatch(
    rows: GeoEntityUpsertRow[],
    manager?: EntityManager,
  ): Promise<void> {
    if (rows.length === 0) return;
    const db = manager ?? this.dataSource;
    const column = <K extends keyof GeoEntityUpsertRow>(key: K) =>
      rows.map((r) => r[key]);
    const setClause = UPSERT_COLUMNS.filter((c) => c !== 'type' && c !== 'code')
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(', ');
    await db.query(
      `INSERT INTO geo_entity (${UPSERT_COLUMNS.map((c) => `"${c}"`).join(', ')})
       SELECT * FROM unnest(
         $1::geo_entity_type[], $2::uuid[], $3::text[], $4::text[], $5::text[],
         $6::double precision[], $7::double precision[], $8::boolean[],
         $9::geo_entity_status[], $10::management_group[], $11::smallint[],
         $12::smallint[], $13::jsonb[], $14::text[], $15::timestamptz[]
       )
       ON CONFLICT ("type", "code") DO UPDATE SET ${setClause}, "updated_at" = now()`,
      [
        column('type'),
        column('parent_id'),
        column('code'),
        column('name'),
        column('lgd_code'),
        column('lat'),
        column('lng'),
        column('has_boundary'),
        column('status'),
        column('management_group'),
        column('class_from'),
        column('class_to'),
        rows.map((r) => JSON.stringify(r.attributes)),
        column('source'),
        column('source_pulled_at'),
      ],
    );
  }

  // Set-based merged-pointer pass: non-operational schools whose schIdMerged
  // names another school's schoolId. Self-references and unresolvable ids
  // simply fail the join. Returns the number of pointers set.
  async linkMergedSchools(): Promise<number> {
    const result: unknown = await this.dataSource.query(
      `UPDATE geo_entity s SET merged_into_id = t.id, updated_at = now()
       FROM geo_entity t
       WHERE s.type = 'school' AND s.status <> 'operational'
         AND s.attributes->>'schIdMerged' NOT IN ('', '0')
         AND t.type = 'school'
         AND t.id <> s.id
         AND t.attributes->>'schoolId' = s.attributes->>'schIdMerged'`,
    );
    // node-postgres returns [rows, rowCount] for UPDATE through TypeORM.
    return Array.isArray(result) && typeof result[1] === 'number'
      ? result[1]
      : 0;
  }

  async mergeEdges(): Promise<MergeEdge[]> {
    return this.dataSource.query(
      `SELECT id, merged_into_id, status FROM geo_entity
       WHERE type = 'school' AND merged_into_id IS NOT NULL`,
    );
  }

  async clearMergedInto(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.dataSource.query(
      `UPDATE geo_entity SET merged_into_id = NULL, updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    this.logger.log(`clearMergedInto: nulled ${ids.length} merge pointers`);
  }
}
