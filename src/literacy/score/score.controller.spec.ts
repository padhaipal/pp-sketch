// uuid is ESM-only — transitively imported via ScoreService → user.dto.
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'gen-uuid'),
  validate: (s: unknown): boolean =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));

import { ScoreController } from './score.controller';
import type { ScoreService } from './score.service';

describe('ScoreController.letterBins', () => {
  it('delegates to ScoreService.getLetterBins with the parsed users array', async () => {
    const expected = [
      {
        userId: 'u1',
        userPhone: '919999990001',
        bins: { untouched: ['क'], regressed: [], learnt: [], improved: [] },
      },
    ];
    const svc = {
      getLetterBins: jest.fn().mockResolvedValue(expected),
    } as unknown as ScoreService;

    const ctrl = new ScoreController(svc);
    const out = await ctrl.letterBins({ users: ['u1'] });

    expect(svc.getLetterBins).toHaveBeenCalledWith(['u1']);
    expect(out).toBe(expected);
  });
});
