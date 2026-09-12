import { backfillBlockCoords } from './backfill-block-coords';
import { geometricMedian } from '../geo-entities/geometric-median';

function makeDeps(fixture: {
  districts: string[];
  blocks: Record<string, string>; // block id → district id
  schools: Array<{ block: string; lat: number | null; lng: number | null }>;
}) {
  const updates: Array<[string, number, number]> = [];
  let txDepth = 0;
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('block-coords:districts'))
      return fixture.districts.map((id) => ({ id }));
    if (sql.includes('block-coords:schools')) {
      return fixture.schools
        .filter(
          (s) =>
            fixture.blocks[s.block] === params[0] &&
            s.lat !== null &&
            s.lng !== null,
        )
        .map((s) => ({ block_id: s.block, lat: s.lat, lng: s.lng }));
    }
    if (sql.includes('block-coords:blocks')) {
      return Object.entries(fixture.blocks)
        .filter(([, d]) => d === params[0])
        .map(([id]) => ({ id }));
    }
    throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
  });
  return {
    deps: {
      log: jest.fn(),
      query,
      transaction: async <T>(fn: () => Promise<T>) => {
        txDepth += 1;
        try {
          return await fn();
        } finally {
          txDepth -= 1;
        }
      },
      updateBlockCoordinates: jest.fn(
        async (id: string, lat: number, lng: number) => {
          expect(txDepth).toBe(1);
          updates.push([id, lat, lng]);
        },
      ),
    },
    updates,
    query,
  };
}

describe('backfillBlockCoords', () => {
  it('writes the geometric median per block, one transaction per district, and leaves unlocated blocks alone', async () => {
    const cluster = Array.from({ length: 10 }, (_, i) => ({
      block: 'b1',
      lat: 26.8 + i * 0.001,
      lng: 80.9,
    }));
    const { deps, updates, query } = makeDeps({
      districts: ['d1', 'd2'],
      blocks: { b1: 'd1', b2: 'd1', b3: 'd2' },
      schools: [
        ...cluster,
        { block: 'b1', lat: 27.4, lng: 80.9 }, // outlier
        { block: 'b2', lat: null, lng: null }, // unlocated only
        { block: 'b3', lat: 30, lng: 75 },
      ],
    });
    const summary = await backfillBlockCoords(deps);
    expect(summary).toEqual({
      districts: 2,
      blocksLocated: 2,
      blocksUnlocated: 1,
    });
    const b1 = updates.find(([id]) => id === 'b1')!;
    const expected = geometricMedian([...cluster, { lat: 27.4, lng: 80.9 }])!;
    expect(b1[1]).toBeCloseTo(expected.lat, 10);
    expect(b1[2]).toBeCloseTo(expected.lng, 10);
    // Median sits inside the cluster, not dragged toward the outlier.
    expect(b1[1]).toBeLessThan(26.81);
    expect(updates.find(([id]) => id === 'b3')).toEqual(['b3', 30, 75]);
    expect(updates.find(([id]) => id === 'b2')).toBeUndefined();
    // Reads are per district: districts + 2 per district.
    expect(query).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
