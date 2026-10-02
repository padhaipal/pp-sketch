// uuid is ESM-only — transitively imported via ScoreService → user.dto.
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'gen-uuid'),
  validate: (s: unknown): boolean =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));

import { BadRequestException } from '@nestjs/common';
import { ScoreController } from './score.controller';
import type { ScoreService } from './score.service';
import type { PiiAccessService } from '../../users/pii-access.service';
import { ANONYMOUS, STAFF } from '../../auth/viewer';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const bins = { untouched: ['क'], regressed: [], learnt: [], improved: [] };

function make(visible: string[]) {
  const svc = {
    getLetterBins: jest.fn().mockResolvedValue([
      { userId: U1, userPhone: '919999990001', bins },
      { userId: U2, userPhone: '919999990002', bins },
    ]),
  } as unknown as ScoreService;
  const visibleTo = jest.fn().mockResolvedValue(new Set(visible));
  const ctrl = new ScoreController(svc, {
    visibleTo,
  } as unknown as PiiAccessService);
  return { ctrl, svc, visibleTo };
}

describe('ScoreController.letterBins', () => {
  it('delegates to ScoreService.getLetterBins with the parsed users array and masks the phones the viewer may not see', async () => {
    const { ctrl, svc, visibleTo } = make([U1]);
    const viewer = { kind: 'user' as const, id: U2 };
    const out = await ctrl.letterBins({ users: [U1, U2] }, viewer);
    expect(svc.getLetterBins).toHaveBeenCalledWith([U1, U2]);
    expect(visibleTo).toHaveBeenCalledWith(viewer, [U1, U2]);
    expect(out.map((r) => r.userPhone)).toEqual(['919999990001', '9...2']);
    // bins untouched by the masking
    expect(out[1].bins).toBe(bins);
  });

  it('staff may name students by phone; everyone else must use uuids (no phone → id oracle)', async () => {
    const { ctrl, svc } = make([U1, U2]);
    await ctrl.letterBins({ users: ['919999990001'] }, STAFF);
    expect(svc.getLetterBins).toHaveBeenCalledWith(['919999990001']);
    for (const viewer of [ANONYMOUS, { kind: 'user' as const, id: U1 }]) {
      await expect(
        ctrl.letterBins({ users: [U1, '919999990001'] }, viewer),
      ).rejects.toThrow(BadRequestException);
    }
    expect(svc.getLetterBins).toHaveBeenCalledTimes(1);
  });

  it('defaults to the anonymous viewer: every phone masked', async () => {
    const { ctrl, visibleTo } = make([]);
    const out = await ctrl.letterBins({ users: [U1] });
    expect(visibleTo).toHaveBeenCalledWith(ANONYMOUS, [U1, U2]);
    expect(out.map((r) => r.userPhone)).toEqual(['9...1', '9...2']);
  });
});
