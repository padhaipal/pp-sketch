// uuid is ESM-only — the transitively-imported MediaMetaDataService pulls it.
jest.mock('uuid', () => ({ v4: jest.fn(() => 'unused-mock-uuid') }));

const mockTrigger = jest.fn();
jest.mock('./morning-update.processor', () => ({
  triggerMorningUpdateForUser: (...args: unknown[]) => mockTrigger(...args),
}));

import { BadRequestException } from '@nestjs/common';
import {
  MorningUpdateController,
  TriggerMorningUpdateDto,
} from './morning-update.controller';
import type { UserService } from '../users/user.service';
import type { MediaMetaDataService } from '../media-meta-data/media-meta-data.service';

function makeController(): MorningUpdateController {
  return new MorningUpdateController(
    {} as UserService,
    {} as MediaMetaDataService,
  );
}

beforeEach(() => mockTrigger.mockReset());

describe('MorningUpdateController.send', () => {
  it('delegates to triggerMorningUpdateForUser when user_id is provided', async () => {
    const ctrl = makeController();
    mockTrigger.mockResolvedValue({
      job_id: 'j1',
      user_id: 'u1',
      user_external_id: '91999',
    });
    const body: TriggerMorningUpdateDto = { user_id: 'u1' };

    const out = await ctrl.send(body);

    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger.mock.calls[0][0]).toBe('u1');
    expect(out.job_id).toBe('j1');
  });

  it('delegates when user_external_id is provided', async () => {
    const ctrl = makeController();
    mockTrigger.mockResolvedValue({
      job_id: 'j2',
      user_id: 'u2',
      user_external_id: '91888',
    });

    const out = await ctrl.send({ user_external_id: '91888' });

    expect(mockTrigger.mock.calls[0][0]).toBe('91888');
    expect(out.user_external_id).toBe('91888');
  });

  it('throws BadRequestException when neither id is provided', async () => {
    const ctrl = makeController();
    await expect(ctrl.send({})).rejects.toThrow(BadRequestException);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when both ids are provided', async () => {
    const ctrl = makeController();
    await expect(
      ctrl.send({ user_id: 'u1', user_external_id: '91888' }),
    ).rejects.toThrow(BadRequestException);
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
