import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { DashboardScoresController } from './dashboard-scores.controller';
import type { DashboardScoresService } from './dashboard-scores.service';
import { PUBLIC_CACHE_CONTROL } from './dashboard-scores.dto';

const ID = '11111111-1111-4111-8111-111111111111';

function make() {
  const scores = jest.fn().mockResolvedValue({
    metric: 'mpl_b',
    range: 90,
    entity: { type: 'block', code: '010101' },
    children: [{ id: 'a', name: 'X, Y', n: 1 }],
  });
  const spotlight = jest
    .fn()
    .mockResolvedValue({ top: null, most_improved: null });
  const ctrl = new DashboardScoresController({
    scores,
    spotlight,
  } as unknown as DashboardScoresService);
  return { ctrl, scores, spotlight };
}

// Nest stores @Header values as route metadata on the handler.
function headers(
  target: object,
  method: string,
): Array<{ name: string; value: string }> {
  return (Reflect.getMetadata(
    '__headers__',
    (target as Record<string, unknown>)[method] as object,
  ) ?? []) as Array<{ name: string; value: string }>;
}

describe('DashboardScoresController', () => {
  it('validates metric and range (range defaults to 30) and forwards to the service', async () => {
    const { ctrl, scores, spotlight } = make();
    await ctrl.getScores(ID, 'mpl_b', '90');
    expect(scores).toHaveBeenCalledWith(ID, 'mpl_b', 90);
    await ctrl.getSpotlight(ID, 'nipun_g2', undefined);
    expect(spotlight).toHaveBeenCalledWith(ID, 'nipun_g2', 30);
    await expect(ctrl.getScores(ID, 'x', '30')).rejects.toThrow(
      BadRequestException,
    );
    await expect(ctrl.getScores(ID, 'mpl_b', '7')).rejects.toThrow(
      BadRequestException,
    );
    await expect(ctrl.getScores('nope', 'mpl_b', '30')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('CSV: text/csv of the children with a filename from entity/metric/range', async () => {
    const { ctrl } = make();
    const res = { setHeader: jest.fn() };
    const csv = await ctrl.getScoresCsv(ID, res as never, 'mpl_b', '90');
    expect(csv).toBe('id,name,n\na,"X, Y",1');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="lifteracy-block-010101-mpl_b-90d.csv"',
    );
  });

  it('sets Cache-Control on all three public GETs and text/csv on the CSV', () => {
    const proto = DashboardScoresController.prototype;
    for (const method of ['getScores', 'getScoresCsv', 'getSpotlight']) {
      expect(headers(proto, method)).toEqual(
        expect.arrayContaining([
          { name: 'Cache-Control', value: PUBLIC_CACHE_CONTROL },
        ]),
      );
    }
    expect(headers(proto, 'getScoresCsv')).toEqual(
      expect.arrayContaining([
        { name: 'Content-Type', value: 'text/csv; charset=utf-8' },
      ]),
    );
    expect(PUBLIC_CACHE_CONTROL).toBe('public, max-age=300');
  });
});
