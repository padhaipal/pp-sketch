// Unit tests for OutboundMessageService. DB is mocked; uuid is pinned.

jest.mock('uuid', () => ({ v4: jest.fn(() => 'gen-uuid') }));

import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { OutboundMessageService } from './outbound-message.service';

function makeService(dsQuery = jest.fn()) {
  const ds = { query: dsQuery } as unknown as DataSource;
  return { service: new OutboundMessageService(ds), dsQuery };
}

afterEach(() => jest.restoreAllMocks());

describe('OutboundMessageService.recordSent', () => {
  it('writes one batched INSERT with a row per item', async () => {
    const { service, dsQuery } = makeService(jest.fn().mockResolvedValue([]));

    await service.recordSent({
      user_id: 'u-1',
      user_message_id: 'mm-1',
      trigger: 'inbound-reply',
      items: [
        { media_metadata_id: 'media-a', state_transition_id: 'stid-a' },
        { media_metadata_id: 'media-b' },
      ],
    });

    expect(dsQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = dsQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO outbound_messages');
    expect(sql).toContain('"trigger"'); // reserved word must stay quoted
    expect((sql.match(/\(\$/g) ?? []).length).toBe(2); // two VALUES rows
    expect(params).toEqual([
      'u-1',
      'mm-1',
      'inbound-reply',
      'gen-uuid',
      'stid-a',
      'media-a',
      'gen-uuid',
      null,
      'media-b',
    ]);
  });

  it('defaults trigger to "other" when omitted or unknown', async () => {
    const { service, dsQuery } = makeService(jest.fn().mockResolvedValue([]));
    await service.recordSent({
      user_id: 'u-1',
      items: [{ media_metadata_id: 'media-a' }],
    });
    await service.recordSent({
      user_id: 'u-1',
      trigger: 'brand-new-flow' as never,
      items: [{ media_metadata_id: 'media-a' }],
    });
    expect(dsQuery.mock.calls[0][1][2]).toBe('other');
    expect(dsQuery.mock.calls[1][1][2]).toBe('other');
  });

  it('defaults user_message_id to null', async () => {
    const { service, dsQuery } = makeService(jest.fn().mockResolvedValue([]));
    await service.recordSent({
      user_id: 'u-1',
      trigger: 'morning-update',
      items: [{ media_metadata_id: 'media-a' }],
    });
    expect(dsQuery.mock.calls[0][1][1]).toBeNull();
  });

  it('no-ops on empty items and on missing user_id', async () => {
    const { service, dsQuery } = makeService();
    await service.recordSent({ user_id: 'u-1', items: [] });
    await service.recordSent({
      user_id: '',
      items: [{ media_metadata_id: 'media-a' }],
    });
    expect(dsQuery).not.toHaveBeenCalled();
  });

  it('NEVER throws on a DB failure — logs an audit-hole ERROR instead', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { service } = makeService(
      jest.fn().mockRejectedValue(new Error('db down')),
    );

    await expect(
      service.recordSent({
        user_id: 'u-1',
        trigger: 'inbound-reply',
        items: [{ media_metadata_id: 'media-a' }],
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('recordSent FAILED (audit hole)'),
    );
  });
});
