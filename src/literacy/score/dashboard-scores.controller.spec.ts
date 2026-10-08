import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { DashboardScoresController } from './dashboard-scores.controller';
import type { DashboardScoresService } from './dashboard-scores.service';
import { PUBLIC_CACHE_CONTROL } from './dashboard-scores.dto';
import { ANONYMOUS, STAFF } from '../../auth/viewer';

const ID = '11111111-1111-4111-8111-111111111111';

function make() {
  const scores = jest.fn().mockResolvedValue({
    metric: 'mpl_b',
    range: 'all',
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
    await ctrl.getScores(ID, 'mpl_b', 'all');
    expect(scores).toHaveBeenCalledWith(
      ID,
      'mpl_b',
      'all',
      undefined,
      ANONYMOUS,
    );
    await ctrl.getSpotlight(ID, 'nipun_g2', undefined);
    expect(spotlight).toHaveBeenCalledWith(
      ID,
      'nipun_g2',
      30,
      undefined,
      ANONYMOUS,
    );
    // Time window: validated and forwarded; absent stays undefined (the
    // legacy usage response).
    await ctrl.getScores(ID, 'usage', '30', '7d');
    expect(scores).toHaveBeenLastCalledWith(ID, 'usage', 30, '7d', ANONYMOUS);
    await ctrl.getSpotlight(ID, 'usage', 'all', 'yesterday');
    expect(spotlight).toHaveBeenLastCalledWith(
      ID,
      'usage',
      'all',
      'yesterday',
      ANONYMOUS,
    );
    await ctrl.getScores(ID, 'usage', '30', '');
    expect(scores).toHaveBeenLastCalledWith(
      ID,
      'usage',
      30,
      undefined,
      ANONYMOUS,
    );
    await expect(ctrl.getScores(ID, 'usage', '30', 'week')).rejects.toThrow(
      /window must be one of: yesterday, 7d, all/,
    );
    await expect(
      ctrl.getSpotlight(ID, 'usage', '30', 'last-week'),
    ).rejects.toThrow(BadRequestException);
    await expect(ctrl.getScores(ID, 'x', '30')).rejects.toThrow(
      BadRequestException,
    );
    await expect(ctrl.getScores(ID, 'mpl_b', '7')).rejects.toThrow(
      BadRequestException,
    );
    await expect(ctrl.getScores(ID, 'mpl_b', '90')).rejects.toThrow(
      BadRequestException,
    );
    await expect(ctrl.getScores('nope', 'mpl_b', '30')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('CSV: text/csv of the children with a filename from entity/metric/range', async () => {
    const { ctrl } = make();
    const res = { setHeader: jest.fn() };
    const csv = await ctrl.getScoresCsv(ID, res as never, 'mpl_b', 'all');
    expect(csv).toBe('id,name,n\na,"X, Y",1');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="lifteracy-block-010101-mpl_b-all-time.csv"',
    );
  });

  it('CSV in Time mode: the window is forwarded and named in the filename', async () => {
    const { ctrl, scores } = make();
    scores.mockResolvedValue({
      metric: 'usage',
      range: 30,
      window: '7d',
      entity: { type: 'block', code: '010101' },
      children: [{ id: 'a', time_total: 21, time_per_day: 3, time_days: 7 }],
    });
    const res = { setHeader: jest.fn() };
    const csv = await ctrl.getScoresCsv(
      ID,
      res as never,
      'usage',
      '30',
      '7d',
      STAFF,
    );
    expect(scores).toHaveBeenCalledWith(ID, 'usage', 30, '7d', STAFF);
    expect(csv).toBe('id,time_total,time_per_day,time_days\na,21,3,7');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="lifteracy-block-010101-usage-time-7d.csv"',
    );
  });

  it('forwards the viewer to the service on every read (who is looking decides the masking)', async () => {
    const { ctrl, scores, spotlight } = make();
    const viewer = { kind: 'user' as const, id: ID };
    await ctrl.getScores(ID, 'mpl_b', 'all', undefined, viewer);
    expect(scores).toHaveBeenLastCalledWith(
      ID,
      'mpl_b',
      'all',
      undefined,
      viewer,
    );
    await ctrl.getSpotlight(ID, 'mpl_b', 'all', undefined, viewer);
    expect(spotlight).toHaveBeenLastCalledWith(
      ID,
      'mpl_b',
      'all',
      undefined,
      viewer,
    );
  });

  it('sets a PRIVATE Cache-Control on all three GETs (responses differ per viewer) and text/csv on the CSV', () => {
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
    expect(PUBLIC_CACHE_CONTROL).toBe('private, no-store');
  });
});
