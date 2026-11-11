import { DataSource } from 'typeorm';
import { ReferralClickService } from './referral-click.service';

function makeService(query: jest.Mock): ReferralClickService {
  return new ReferralClickService({ query } as unknown as DataSource);
}

const HASH = 'a'.repeat(64);

describe('ReferralClickService.recordClick', () => {
  it('inserts one row, resolving the referrer to a user and keeping the raw segment only when unmatched', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await makeService(query).recordClick({
      referrer: '919999990001',
      visitor_hash: HASH,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO referral_link_clicks/);
    expect(sql).toMatch(/LEFT JOIN users u ON u\.external_id = r\.ext/);
    expect(sql).toMatch(/CASE WHEN u\.id IS NULL THEN r\.ext END/);
    expect(params).toEqual(['919999990001', HASH]);
  });
});

describe('ReferralClickService.summary', () => {
  it('returns matched referrers and unmatched segments since the given time', async () => {
    const referrers = [
      {
        user_id: 'u-1',
        name: 'Asha',
        external_id: '919999990001',
        clicks: 5,
        unique_visitors: 3,
        signups: 2,
      },
    ];
    const unmatched = [
      { referrer: '910000000000', clicks: 1, unique_visitors: 1 },
    ];
    const query = jest
      .fn()
      .mockResolvedValueOnce(referrers)
      .mockResolvedValueOnce(unmatched);
    const since = new Date('2026-11-01T00:00:00+05:30');

    const result = await makeService(query).summary(since);

    expect(result).toEqual({
      since: since.toISOString(),
      referrers,
      unmatched,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toMatch(/count\(DISTINCT c\.visitor_hash\)/);
    expect(query.mock.calls[0][0]).toMatch(/s\.referrer_user_id = u\.id/);
    expect(query.mock.calls[0][1]).toEqual([since]);
    expect(query.mock.calls[1][0]).toMatch(/referrer_user_id IS NULL/);
    expect(query.mock.calls[1][1]).toEqual([since]);
  });
});
