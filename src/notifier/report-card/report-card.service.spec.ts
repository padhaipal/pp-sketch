// ReportCardService: yesterday's figures (data layer, no DB) and the PNG
// pipeline (sharp mocked). The SVG itself is covered in report-card.svg.spec.

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'gen-uuid'),
  validate: (s: unknown): boolean =>
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));
jest.mock('sharp', () => {
  const calls: Buffer[] = [];
  const sharpMock = jest.fn((input: Buffer) => {
    calls.push(input);
    return {
      png: () => ({ toBuffer: () => Promise.resolve(Buffer.from('fake-png')) }),
    };
  });
  (sharpMock as unknown as { __calls: Buffer[] }).__calls = calls;
  return sharpMock;
});

import sharp from 'sharp';
import { NotFoundException } from '@nestjs/common';
import { ReportCardService } from './report-card.service';
import {
  FIVE_MINUTES_MS,
  levelBand,
  minutesOf,
  pickPraise,
  PRAISE_LINES,
  timeBand,
} from './report-card.dto';
import { REPORT_CARD_WIDTH } from './report-card.dto';

const USER = { id: 'u1', external_id: '918888888001' };
// 07:00 IST on 2026-04-28 → yesterday = 2026-04-27 IST
const NOW = new Date('2026-04-28T01:30:00Z');
const YESTERDAY_MID = new Date('2026-04-26T18:30:00Z');
const TODAY_MID = new Date('2026-04-27T18:30:00Z');

function makeService(opts: {
  user?: typeof USER | null;
  activeMs?: number;
  levels?: { level_end: number | null; level_start: number | null };
  letters?: string[];
  existingMedia?: { id: string; status: string };
}) {
  const user = opts.user === undefined ? USER : opts.user;
  const userService = {
    findByIdOrExternalId: jest.fn().mockResolvedValue(user),
  };
  const getActivityTime = jest
    .fn()
    .mockImplementation(
      ({ windows }: { windows: Array<{ start: string; end: string }> }) => ({
        results: user
          ? [
              {
                user_id: user.id,
                external_id: user.external_id,
                windows: windows.map((w) => ({
                  ...w,
                  active_ms: opts.activeMs ?? 0,
                })),
              },
            ]
          : [],
      }),
    );
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('report-card:levels'))
      return [opts.levels ?? { level_end: null, level_start: null }];
    if (sql.includes('report-card:letters'))
      return (opts.letters ?? []).map((grapheme) => ({ grapheme, n: 1 }));
    throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
  });
  const mediaRepo = {
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(opts.existingMedia ?? null),
    }),
  };
  const svc = new ReportCardService(
    userService as never,
    { getActivityTime } as never,
    { query } as never,
    mediaRepo as never,
  );
  return { svc, getActivityTime, query, mediaRepo };
}

describe('report-card bands and praise', () => {
  it('time: five minutes is a good day (inclusive), any practice ok, none poor; minutes never round a little practice down to 0', () => {
    expect(timeBand(FIVE_MINUTES_MS)).toBe('good');
    expect(timeBand(FIVE_MINUTES_MS - 1)).toBe('ok');
    expect(timeBand(1)).toBe('ok');
    expect(timeBand(0)).toBe('poor');
    expect(minutesOf(0)).toBe(0);
    expect(minutesOf(10_000)).toBe(1);
    expect(minutesOf(18 * 60_000 + 20_000)).toBe(18);
  });

  it('level: up is good, unchanged ok, down poor', () => {
    expect(levelBand(2)).toBe('good');
    expect(levelBand(0)).toBe('ok');
    expect(levelBand(-1)).toBe('poor');
  });

  it('praise: the approved Hindi lines per band (17 / 17 / 18), stable for a child within a day, varying across days and children', () => {
    for (const band of ['good', 'ok', 'poor'] as const) {
      expect(PRAISE_LINES[band].length).toBeGreaterThanOrEqual(17);
      for (const line of PRAISE_LINES[band]) {
        expect(line.length).toBeLessThanOrEqual(40);
        expect(line).toMatch(/^[ऀ-ॿ\s!?,.-]+$/); // Devanagari + punctuation only
      }
    }
    expect(pickPraise('good', 'u1', 100)).toBe(pickPraise('good', 'u1', 100));
    const days = new Set(
      Array.from({ length: PRAISE_LINES.good.length }, (_, d) =>
        pickPraise('good', 'u1', d),
      ),
    );
    expect(days.size).toBe(PRAISE_LINES.good.length);
    expect(pickPraise('ok', 'u1', 5)).not.toBe(pickPraise('ok', 'u2', 5));
    expect(PRAISE_LINES.poor).toContain(pickPraise('poor', 'abc', 7));
  });
});

describe('ReportCardService.buildData', () => {
  it("reads yesterday's IST window only, the level before and after it, and the top letters; a good day", async () => {
    const { svc, getActivityTime, query } = makeService({
      activeMs: 18 * 60_000,
      levels: { level_end: 9, level_start: 7 },
      letters: ['क', 'म', 'त'],
    });
    const data = await svc.buildData('u1', { now: NOW });
    expect(getActivityTime).toHaveBeenCalledWith({
      users: ['u1'],
      windows: [
        { start: YESTERDAY_MID.toISOString(), end: TODAY_MID.toISOString() },
      ],
    });
    const levelCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('report-card:levels'),
    )!;
    expect(levelCall[1]).toEqual(['u1', TODAY_MID, YESTERDAY_MID]);
    const letterCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('report-card:letters'),
    )!;
    expect(letterCall[1]).toEqual(['u1', YESTERDAY_MID, TODAY_MID]);
    expect(String(letterCall[0])).toContain('m.rolled_back = false');
    expect(data).toEqual({
      user_external_id: '918888888001',
      active_ms: 18 * 60_000,
      minutes: 18,
      time_band: 'good',
      level_delta: 2,
      level_band: 'good',
      top_letters: ['क', 'म', 'त'],
      praise: expect.any(String) as unknown,
    });
    expect(PRAISE_LINES.good).toContain(data.praise);
  });

  it('no practice yesterday: poor time band, 0 minutes, a poor-band praise line; unknown levels → delta 0 (ok)', async () => {
    const { svc } = makeService({ activeMs: 0 });
    const data = await svc.buildData('918888888001', { now: NOW });
    expect(data).toMatchObject({
      minutes: 0,
      time_band: 'poor',
      level_delta: 0,
      level_band: 'ok',
      top_letters: [],
    });
    expect(PRAISE_LINES.poor).toContain(data.praise);
  });

  it('a little practice is an ok day; a level drop is a poor level band; numeric strings from the driver are read as numbers', async () => {
    const { svc } = makeService({
      activeMs: 40_000,
      levels: {
        level_end: '8' as unknown as number,
        level_start: '9' as unknown as number,
      },
    });
    const data = await svc.buildData('u1', { now: NOW });
    expect(data).toMatchObject({
      minutes: 1,
      time_band: 'ok',
      level_delta: -1,
      level_band: 'poor',
    });
    expect(PRAISE_LINES.ok).toContain(data.praise);
  });

  it('first lesson ever yesterday (no level before it) counts as no change', async () => {
    const { svc } = makeService({
      activeMs: 60_000,
      levels: { level_end: 2, level_start: null },
    });
    expect((await svc.buildData('u1', { now: NOW })).level_delta).toBe(0);
  });

  it('throws NotFound for an unknown user', async () => {
    const { svc } = makeService({ user: null });
    await expect(svc.buildData('nope', { now: NOW })).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('ReportCardService.generatePng', () => {
  beforeEach(() => {
    (sharp as unknown as { __calls: Buffer[] }).__calls.length = 0;
  });

  it('renders the SVG through the sharp PNG pipeline and returns buffer + data', async () => {
    const { svc } = makeService({ activeMs: 6 * 60_000, letters: ['क'] });
    const { buffer, data } = await svc.generatePng('u1', { now: NOW });
    expect(buffer).toEqual(Buffer.from('fake-png'));
    expect(data.user_external_id).toBe('918888888001');
    expect(sharp).toHaveBeenCalledTimes(1);
    const svg = (sharp as unknown as { __calls: Buffer[] }).__calls[0].toString(
      'utf-8',
    );
    expect(svg).toContain(`width="${REPORT_CARD_WIDTH}"`);
    expect(svg).toContain('data-header="good"');
    expect(svg).toContain('data-chip="क"');
  });
});

describe('ReportCardService.findExistingForUser', () => {
  it("returns the matched media row when one exists, null otherwise, filtering to today's morning-update images", async () => {
    const row = { id: 'mm-1', status: 'ready' };
    const { svc, mediaRepo } = makeService({ existingMedia: row });
    expect(await svc.findExistingForUser('u1', new Date())).toEqual(row);
    const qb = mediaRepo.createQueryBuilder.mock.results[0].value as {
      where: jest.Mock;
      andWhere: jest.Mock;
    };
    expect(qb.where).toHaveBeenCalledWith('mm.user_id = :userId', {
      userId: 'u1',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('mm.source = :source', {
      source: 'morning-update',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('mm.rolled_back = :rolled_back', {
      rolled_back: false,
    });
    const none = makeService({});
    expect(await none.svc.findExistingForUser('u1', new Date())).toBeNull();
  });
});
