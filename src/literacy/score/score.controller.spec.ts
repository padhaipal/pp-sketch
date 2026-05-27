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
