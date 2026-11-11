import { BadRequestException } from '@nestjs/common';
import { ReferralClickController } from './referral-click.controller';
import { ReferralClickService } from './referral-click.service';

function makeController(): {
  controller: ReferralClickController;
  recordClick: jest.Mock;
  summary: jest.Mock;
} {
  const recordClick = jest.fn().mockResolvedValue(undefined);
  const summary = jest
    .fn()
    .mockResolvedValue({ since: 'x', referrers: [], unmatched: [] });
  const service = { recordClick, summary } as unknown as ReferralClickService;
  return {
    controller: new ReferralClickController(service),
    recordClick,
    summary,
  };
}

describe('ReferralClickController', () => {
  it('records a click', async () => {
    const { controller, recordClick } = makeController();
    const body = { referrer: '919999990001', visitor_hash: 'b'.repeat(64) };
    await expect(controller.record(body)).resolves.toEqual({ ok: true });
    expect(recordClick).toHaveBeenCalledWith(body);
  });

  it('reads the summary from midnight IST on the given day', async () => {
    const { controller, summary } = makeController();
    await controller.summary('2026-11-01');
    const since: Date = summary.mock.calls[0][0];
    expect(since.toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });

  it.each([undefined, '', '1 Nov', '2026-13-45'])(
    'rejects a bad since (%p)',
    async (since) => {
      const { controller, summary } = makeController();
      await expect(controller.summary(since as string)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(summary).not.toHaveBeenCalled();
    },
  );
});
