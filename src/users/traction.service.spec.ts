import { TractionService } from './traction.service';
import type { CacheService } from '../interfaces/redis/cache';
import type { DataSource } from 'typeorm';

process.env.ONBOARDING_CUTOFF ??= '2026-01-01T00:00:00Z';

function make(cached: unknown = null) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('traction:activity'))
      return [
        {
          k: 'd',
          date: '2026-09-01',
          user_id: null,
          users_over_5min: 2,
          active_ms: '600000',
        },
        {
          k: 'm',
          date: '2026-09',
          user_id: 's1',
          users_over_5min: null,
          active_ms: null,
        },
      ];
    if (sql.includes('traction:students'))
      return [
        {
          id: 's1',
          onboarded_on: '2026-09-01',
          units: [{ id: 'g', type: 'school' }],
        },
      ];
    if (sql.includes('traction:teachers'))
      return [{ created_on: '2026-09-01' }];
    return [];
  });
  const cache = {
    get: jest.fn().mockResolvedValue(cached),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new TractionService(
    { query } as unknown as DataSource,
    cache as unknown as CacheService,
  );
  return { svc, query, cache };
}

const NOW = new Date('2026-09-03T06:00:00Z'); // 11:30 IST on 2026-09-03

describe('TractionService', () => {
  it('a cache hit is returned without touching the database', async () => {
    const { svc, query, cache } = make({ daily: [] });
    expect(await svc.get(NOW)).toEqual({ daily: [] });
    expect(cache.get).toHaveBeenCalledWith('dashboard:traction:v3:2026-09-03');
    expect(query).not.toHaveBeenCalled();
  });

  it('a miss computes through yesterday (IST) and caches under today’s IST date for 26 h', async () => {
    const { svc, cache } = make();
    const out = await svc.get(NOW);
    expect(out.from).toBe('2026-04-01');
    expect(out.to).toBe('2026-09-02');
    expect(out.daily.find((d) => d.date === '2026-09-01')).toEqual(
      expect.objectContaining({
        date: '2026-09-01',
        users_over_5min: 2,
        minutes: 10,
        students_onboarded: 1,
        teachers_onboarded: 1,
        schools: 1,
      }),
    );
    expect(out.monthly.map((m) => m.month)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    expect(out.monthly[5]).toEqual({
      month: '2026-09',
      joined_earlier: 0,
      joined_this_month: 1,
      projected_joined_earlier: 0,
      projected_joined_this_month: 15, // 1 × 30 days ÷ 2 complete days
    });
    expect(cache.set).toHaveBeenCalledWith(
      'dashboard:traction:v3:2026-09-03',
      out,
      26 * 3600,
    );
  });

  it('the monthly read is bounded to the window', async () => {
    const { svc, query } = make();
    await svc.get(NOW);
    const call = query.mock.calls.find(([sql]) =>
      String(sql).includes('traction:activity'),
    ) as unknown as [string, unknown[]];
    expect(call[1]).toEqual([300_000, '2026-04-01', '2026-09-02']);
  });

  it('concurrent misses share one computation', async () => {
    const { svc, query } = make();
    await Promise.all([svc.get(NOW), svc.get(NOW), svc.refresh(NOW)]);
    expect(query).toHaveBeenCalledTimes(4); // one of each read
  });
});
