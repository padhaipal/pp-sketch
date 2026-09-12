/**
 * Block coordinates: the geometric median of a block's located schools,
 * written to geo_entity.lat/lng. Blocks have neither a polygon nor a point
 * of their own; the dashboard renders them as labels at this point. Shared
 * by the standalone backfill (backfill-block-coords.main.ts, for databases
 * seeded before this pass existed) and the seed's final step
 * (seed-geo-entities.ts). Pure over injected I/O; runbook in
 * src/docs/seeding-geo-entities.md.
 */
import { geometricMedian } from '../geo-entities/geometric-median';

export interface BlockCoordsDeps {
  log: (message: string) => void;
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  // GeoEntityService.updateBlockCoordinates — the only write.
  updateBlockCoordinates: (
    id: string,
    lat: number,
    lng: number,
  ) => Promise<void>;
}

export interface BlockCoordsSummary {
  districts: number;
  blocksLocated: number;
  blocksUnlocated: number;
}

interface SchoolPointRow {
  block_id: string;
  lat: number;
  lng: number;
}

// One district-sized chunk per transaction: read (block, lat, lng) for the
// district's located schools, compute each block's median, write it. Blocks
// with no located school are left untouched (null → no label).
export async function backfillBlockCoords(
  deps: BlockCoordsDeps,
): Promise<BlockCoordsSummary> {
  const districts = (await deps.query(
    `/* block-coords:districts */
     SELECT id FROM geo_entity WHERE type = 'district' ORDER BY code`,
  )) as Array<{ id: string }>;
  const summary: BlockCoordsSummary = {
    districts: districts.length,
    blocksLocated: 0,
    blocksUnlocated: 0,
  };

  for (const [i, district] of districts.entries()) {
    const rows = (await deps.query(
      `/* block-coords:schools */
       SELECT b.id AS block_id, s.lat::float8 AS lat, s.lng::float8 AS lng
       FROM geo_entity b
       JOIN geo_entity s ON s.parent_id = b.id AND s.type = 'school'
       WHERE b.parent_id = $1 AND b.type = 'block'
         AND s.lat IS NOT NULL AND s.lng IS NOT NULL`,
      [district.id],
    )) as SchoolPointRow[];
    const blockIds = (await deps.query(
      `/* block-coords:blocks */
       SELECT id FROM geo_entity WHERE parent_id = $1 AND type = 'block'`,
      [district.id],
    )) as Array<{ id: string }>;

    const byBlock = new Map<string, { lat: number; lng: number }[]>();
    for (const row of rows) {
      const list = byBlock.get(row.block_id) ?? [];
      list.push({ lat: row.lat, lng: row.lng });
      byBlock.set(row.block_id, list);
    }

    await deps.transaction(async () => {
      for (const { id } of blockIds) {
        const median = geometricMedian(byBlock.get(id) ?? []);
        if (!median) {
          summary.blocksUnlocated += 1;
          continue;
        }
        await deps.updateBlockCoordinates(id, median.lat, median.lng);
        summary.blocksLocated += 1;
      }
    });

    if ((i + 1) % 100 === 0) {
      deps.log(
        `block coords: ${i + 1}/${districts.length} districts, ${summary.blocksLocated} blocks located`,
      );
    }
  }

  deps.log(
    `block coords: ${summary.blocksLocated} blocks located, ${summary.blocksUnlocated} without a located school, ${summary.districts} districts`,
  );
  return summary;
}
