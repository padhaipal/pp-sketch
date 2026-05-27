import type { DataSource } from 'typeorm';
import { getActiveUsers } from './notifier.utils';

function makeDataSource(query: jest.Mock): DataSource {
  return { query } as unknown as DataSource;
}

describe('getActiveUsers', () => {
  it('passes windowStart and idleSince in that order to a single query', async () => {
    const rows = [
      {
        user_id: 'u1',
        external_id: '919999990001',
        last_message_at: new Date('2026-04-27T09:00:00Z'),
        last_message_id: 'mm-1',
      },
    ];
    const query = jest.fn().mockResolvedValue(rows);
    const ds = makeDataSource(query);

    const windowStart = new Date('2026-04-26T10:00:00Z');
    const idleSince = new Date('2026-04-27T09:55:00Z');

    const out = await getActiveUsers(ds, { windowStart, idleSince });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM media_metadata mm/);
    expect(sql).toMatch(/source = 'whatsapp'/);
    expect(sql).toMatch(/HAVING MAX\(mm\.created_at\) < \$2/);
    expect(params).toEqual([windowStart, idleSince]);
    expect(out).toBe(rows);
  });

  it('returns the empty array when no users match', async () => {
    const ds = makeDataSource(jest.fn().mockResolvedValue([]));
    await expect(
      getActiveUsers(ds, {
        windowStart: new Date(),
        idleSince: new Date(),
      }),
    ).resolves.toEqual([]);
  });
});
