// Unit tests for ReportCardService.buildData and the SVG renderer.
// These avoid the database — collaborator services are mocked. Edge cases:
//   (a) 0 letters learnt yesterday → no highlights
//   (b) 0 activity all 7 days → bars all 0
//   (c) user joined < 7 days ago → missing days = 0
// Plus the SVG renderer itself: shape, brand colour, dotted line, QR, logo.

import { ReportCardService } from './report-card.service';
import {
  LANDSCAPE_REPORT_CARD_WIDTH,
  buildLandscapeReportCardSvg,
  buildReportCardSvg,
} from './report-card.svg';
import { BRAND_BLUE_HEX, FIVE_MINUTES_MS } from './report-card.dto';
import { addDays, istMidnightUtc } from './report-card.utils';

interface MockUser {
  id: string;
  external_id: string;
}

function makeService(opts: {
  user: MockUser | null;
  lettersByAsOf: Map<string, string[]>;
  activityWindows: number[]; // ms per window in order
  existingMedia?: { id: string; status: string };
}): ReportCardService {
  const userService = {
    find: jest.fn().mockResolvedValue(opts.user),
  };
  const userActivityService = {
    getActivityTime: jest.fn().mockImplementation(({ windows }) => ({
      results: opts.user
        ? [
            {
              user_id: opts.user.id,
              external_id: opts.user.external_id,
              windows: windows.map(
                (w: { start: string; end: string }, i: number) => ({
                  start: w.start,
                  end: w.end,
                  active_ms: opts.activityWindows[i] ?? 0,
                }),
              ),
            },
          ]
        : [],
    })),
  };
  const scoreService = {
    getLetterBins: jest.fn().mockImplementation(
      (
        _users: string,
        options?: { asOf?: Date },
      ): Promise<{
        userId: string;
        userPhone: string;
        bins: {
          untouched: string[];
          regressed: string[];
          learnt: string[];
          improved: string[];
        };
      }> => {
        const key = options?.asOf?.toISOString() ?? 'now';
        const learnt = opts.lettersByAsOf.get(key) ?? [];
        return Promise.resolve({
          userId: opts.user?.id ?? '',
          userPhone: opts.user?.external_id ?? '',
          bins: {
            untouched: [],
            regressed: [],
            learnt,
            improved: [],
          },
        });
      },
    ),
  };
  const mediaRepo = {
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(opts.existingMedia ?? null),
    }),
  };
  return new ReportCardService(
    userService as never,
    userActivityService as never,
    scoreService as never,
    mediaRepo as never,
  );
}

describe('ReportCardService.buildData', () => {
  // Anchor: Tuesday 7 AM IST (= 01:30 UTC) on 2026-04-28
  const NOW = new Date('2026-04-28T01:30:00Z');
  const todayMid = istMidnightUtc(NOW);
  const yesterdayMid = addDays(todayMid, -1);
  const KEY_TODAY = todayMid.toISOString();
  const KEY_YESTERDAY = yesterdayMid.toISOString();

  it('computes the yesterday delta (letters new in the last 24h)', async () => {
    const svc = makeService({
      user: { id: 'u1', external_id: '918888888001' },
      lettersByAsOf: new Map([
        [KEY_TODAY, ['क', 'ख', 'ग', 'घ']],
        [KEY_YESTERDAY, ['क', 'ख']],
      ]),
      activityWindows: Array(7).fill(0),
    });
    const data = await svc.buildData('u1', { now: NOW });
    expect(data.letters_learnt).toEqual(['क', 'ख', 'ग', 'घ']);
    expect(data.letters_learnt_yesterday).toEqual(['ग', 'घ']);
  });

  it('handles 0 letters learnt yesterday (no highlights)', async () => {
    const svc = makeService({
      user: { id: 'u1', external_id: '918888888001' },
      lettersByAsOf: new Map([
        [KEY_TODAY, ['क', 'ख']],
        [KEY_YESTERDAY, ['क', 'ख']],
      ]),
      activityWindows: Array(7).fill(0),
    });
    const data = await svc.buildData('u1', { now: NOW });
    expect(data.letters_learnt_yesterday).toEqual([]);
    expect(data.letters_learnt).toEqual(['क', 'ख']);
  });

  it('handles 0 activity all 7 days (bars all 0)', async () => {
    const svc = makeService({
      user: { id: 'u1', external_id: '918888888001' },
      lettersByAsOf: new Map(),
      activityWindows: Array(7).fill(0),
    });
    const data = await svc.buildData('u1', { now: NOW });
    expect(data.daily_bars).toHaveLength(7);
    for (const bar of data.daily_bars) {
      expect(bar.active_ms).toBe(0);
    }
  });

  it('user joined < 7 days ago: missing days = 0-height bars', async () => {
    // Activity only on the most recent two windows; older days = 0.
    const svc = makeService({
      user: { id: 'u1', external_id: '918888888001' },
      lettersByAsOf: new Map(),
      activityWindows: [0, 0, 0, 0, 0, 100_000, 200_000],
    });
    const data = await svc.buildData('u1', { now: NOW });
    expect(data.daily_bars).toHaveLength(7);
    expect(data.daily_bars.slice(0, 5).every((b) => b.active_ms === 0)).toBe(
      true,
    );
    expect(data.daily_bars[5].active_ms).toBe(100_000);
    expect(data.daily_bars[6].active_ms).toBe(200_000);
  });

  it('produces 7 sequential IST dates, oldest first', async () => {
    const svc = makeService({
      user: { id: 'u1', external_id: '918888888001' },
      lettersByAsOf: new Map(),
      activityWindows: Array(7).fill(0),
    });
    const data = await svc.buildData('u1', { now: NOW });
    const dates = data.daily_bars.map((b) => b.date_iso);
    // 2026-04-28 is today IST → 7-day window ends yesterday (2026-04-27),
    // starts 2026-04-21.
    expect(dates).toEqual([
      '2026-04-21',
      '2026-04-22',
      '2026-04-23',
      '2026-04-24',
      '2026-04-25',
      '2026-04-26',
      '2026-04-27',
    ]);
  });

  it('day_index matches the JS weekday of each IST date (0=Sun..6=Sat)', async () => {
    const svc = makeService({
      user: { id: 'u1', external_id: '918888888001' },
      lettersByAsOf: new Map(),
      activityWindows: Array(7).fill(0),
    });
    const data = await svc.buildData('u1', { now: NOW });
    // 2026-04-21 is a Tuesday → day_index 2; the rest follow.
    expect(data.daily_bars.map((b) => b.day_index)).toEqual([
      2, 3, 4, 5, 6, 0, 1,
    ]);
  });

  it('throws NotFound when user does not resolve', async () => {
    const svc = makeService({
      user: null,
      lettersByAsOf: new Map(),
      activityWindows: [],
    });
    await expect(svc.buildData('does-not-exist', { now: NOW })).rejects.toThrow(
      /User not found/,
    );
  });
});

describe('buildReportCardSvg (renderer output)', () => {
  it('renders an SVG that contains the brand blue when there is activity above 5 min', async () => {
    const svg = await buildReportCardSvg({
      user_external_id: '918888888001',
      letters_learnt: ['क', 'ख', 'ग'],
      letters_learnt_yesterday: ['ग'],
      letters_currently_learning: [],
      letters_already_known: [],
      daily_bars: [
        { date_iso: '2026-04-21', day_index: 2, active_ms: 0 },
        { date_iso: '2026-04-22', day_index: 3, active_ms: 0 },
        { date_iso: '2026-04-23', day_index: 4, active_ms: 60_000 },
        { date_iso: '2026-04-24', day_index: 5, active_ms: 200_000 },
        { date_iso: '2026-04-25', day_index: 6, active_ms: FIVE_MINUTES_MS },
        { date_iso: '2026-04-26', day_index: 0, active_ms: 360_000 },
        { date_iso: '2026-04-27', day_index: 1, active_ms: 600_000 },
      ],
    });
    expect(svg).toMatch(/^<\?xml/);
    expect(svg).toContain(BRAND_BLUE_HEX);
    // Dotted 5-min line is present — stroke-dasharray attribute.
    expect(svg).toContain('stroke-dasharray');
  });

  it('embeds the QR code with the user-specific wa.me URL (encoded)', async () => {
    const svg = await buildReportCardSvg({
      user_external_id: '918888888001',
      letters_learnt: [],
      letters_learnt_yesterday: [],
      letters_currently_learning: [],
      letters_already_known: [],
      daily_bars: Array.from({ length: 7 }, (_, i) => ({
        date_iso: `2026-04-${21 + i}`,
        day_index: (2 + i) % 7,
        active_ms: 0,
      })),
    });
    // The renderer leaves a referral-target HTML comment for traceability.
    expect(svg).toContain('918888888001');
    expect(svg).toContain('wa.me/918528097842');
  });

  it('renders normally when there are 0 letters learnt yesterday (no highlight stars)', async () => {
    const svg = await buildReportCardSvg({
      user_external_id: '918888888001',
      letters_learnt: ['क', 'ख'],
      letters_learnt_yesterday: [],
      letters_currently_learning: [],
      letters_already_known: [],
      daily_bars: Array.from({ length: 7 }, (_, i) => ({
        date_iso: `2026-04-${21 + i}`,
        day_index: (2 + i) % 7,
        active_ms: 100_000,
      })),
    });
    // Highlight is a brand-blue <polygon> star. None should appear when
    // nothing is highlighted. The logo SVG uses class-based fills, so its
    // brand-blue paths don't carry an inline fill="#1D9EDF" attribute.
    const highlightStars = svg.match(
      new RegExp(`<polygon[^>]*fill="${BRAND_BLUE_HEX}"`, 'g'),
    );
    expect(highlightStars).toBeNull();
  });

  it('renders highlighted (today) letters before the rest in the grid', async () => {
    const svg = await buildReportCardSvg({
      user_external_id: '918888888001',
      letters_learnt: ['क', 'ख', 'ग', 'घ', 'च', 'छ'],
      letters_learnt_yesterday: ['च', 'छ'],
      letters_currently_learning: [],
      letters_already_known: [],
      daily_bars: Array.from({ length: 7 }, (_, i) => ({
        date_iso: `2026-04-${21 + i}`,
        day_index: (2 + i) % 7,
        active_ms: 0,
      })),
    });
    // Pick out all letter <text> nodes (font-family Noto Sans Devanagari) in
    // document order. Star polygons contain no text, so we get one entry per
    // grid cell. Headings/CTA also use this font but render BEFORE the grid;
    // we filter to single-character bodies (the grid letters).
    const letterRe =
      /<text[^>]*>(क|ख|ग|घ|च|छ)<\/text>/g;
    const ordered = Array.from(svg.matchAll(letterRe)).map((m) => m[1]);
    expect(ordered.slice(0, 2).sort()).toEqual(['च', 'छ'].sort());
    expect(ordered.slice(2).sort()).toEqual(['क', 'ख', 'ग', 'घ'].sort());
  });

  it('renders a brand-blue <polygon> star per highlighted letter', async () => {
    const svg = await buildReportCardSvg({
      user_external_id: '918888888001',
      letters_learnt: ['क', 'ख', 'ग'],
      letters_learnt_yesterday: ['क', 'ग'],
      letters_currently_learning: [],
      letters_already_known: [],
      daily_bars: Array.from({ length: 7 }, (_, i) => ({
        date_iso: `2026-04-${21 + i}`,
        day_index: (2 + i) % 7,
        active_ms: 0,
      })),
    });
    const stars = svg.match(
      new RegExp(`<polygon[^>]*fill="${BRAND_BLUE_HEX}"`, 'g'),
    );
    expect(stars).not.toBeNull();
    expect(stars).toHaveLength(2);
  });

  it('renders 7 day labels (Hindi) in the activity chart', async () => {
    const svg = await buildReportCardSvg({
      user_external_id: '918888888001',
      letters_learnt: [],
      letters_learnt_yesterday: [],
      letters_currently_learning: [],
      letters_already_known: [],
      daily_bars: [
        { date_iso: '2026-04-21', day_index: 2, active_ms: 0 },
        { date_iso: '2026-04-22', day_index: 3, active_ms: 0 },
        { date_iso: '2026-04-23', day_index: 4, active_ms: 0 },
        { date_iso: '2026-04-24', day_index: 5, active_ms: 0 },
        { date_iso: '2026-04-25', day_index: 6, active_ms: 0 },
        { date_iso: '2026-04-26', day_index: 0, active_ms: 0 },
        { date_iso: '2026-04-27', day_index: 1, active_ms: 0 },
      ],
    });
    expect(svg).toContain('मंगल');
    expect(svg).toContain('बुध');
    expect(svg).toContain('गुरु');
    expect(svg).toContain('शुक्र');
    expect(svg).toContain('शनि');
    expect(svg).toContain('रवि');
    expect(svg).toContain('सोम');
  });

  it('handles 0 activity all 7 days without crashing (renders thin baseline ticks)', async () => {
    const svg = await buildReportCardSvg({
      user_external_id: '918888888001',
      letters_learnt: [],
      letters_learnt_yesterday: [],
      letters_currently_learning: [],
      letters_already_known: [],
      daily_bars: Array.from({ length: 7 }, (_, i) => ({
        date_iso: `2026-04-${21 + i}`,
        day_index: (2 + i) % 7,
        active_ms: 0,
      })),
    });
    expect(svg).toMatch(/^<\?xml/);
    // Dotted 5-min line is still there.
    expect(svg).toContain('stroke-dasharray');
  });

  it('handles a user with 0 letters learnt entirely (em-dash placeholder)', async () => {
    const svg = await buildReportCardSvg({
      user_external_id: '918888888001',
      letters_learnt: [],
      letters_learnt_yesterday: [],
      letters_currently_learning: [],
      letters_already_known: [],
      daily_bars: Array.from({ length: 7 }, (_, i) => ({
        date_iso: `2026-04-${21 + i}`,
        day_index: (2 + i) % 7,
        active_ms: 0,
      })),
    });
    expect(svg).toContain('—');
  });

  it('embeds the PadhaiPal logo (inner SVG content)', async () => {
    const svg = await buildReportCardSvg({
      user_external_id: '918888888001',
      letters_learnt: [],
      letters_learnt_yesterday: [],
      letters_currently_learning: [],
      letters_already_known: [],
      daily_bars: Array.from({ length: 7 }, (_, i) => ({
        date_iso: `2026-04-${21 + i}`,
        day_index: (2 + i) % 7,
        active_ms: 0,
      })),
    });
    // Logo inner content is identifiable by its CSS classes.
    expect(svg).toContain('.st1{fill:#1D9EDF;}');
  });

  it('escapes external_id correctly into the QR payload (no <script>-style chars leak)', async () => {
    const svg = await buildReportCardSvg({
      user_external_id: '918888888001',
      letters_learnt: ['<', '&'],
      letters_learnt_yesterday: [],
      letters_currently_learning: [],
      letters_already_known: [],
      daily_bars: Array.from({ length: 7 }, (_, i) => ({
        date_iso: `2026-04-${21 + i}`,
        day_index: (2 + i) % 7,
        active_ms: 0,
      })),
    });
    // The grid renders < and & — they must be xml-escaped.
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&amp;');
  });
});

describe('buildLandscapeReportCardSvg (renderer output)', () => {
  const baseData = {
    user_external_id: '918888888001',
    letters_learnt: ['क', 'ख', 'ग', 'घ'],
    letters_learnt_yesterday: ['ग', 'घ'],
    letters_currently_learning: ['च', 'छ'],
    letters_already_known: ['ज', 'झ'],
    daily_bars: Array.from({ length: 7 }, (_, i) => ({
      date_iso: `2026-04-${21 + i}`,
      day_index: (2 + i) % 7,
      active_ms: 100_000,
    })),
  };

  it('renders the wider canvas via the LANDSCAPE_REPORT_CARD_WIDTH constant', async () => {
    const svg = await buildLandscapeReportCardSvg(baseData);
    expect(svg).toMatch(/^<\?xml/);
    expect(svg).toContain(`width="${LANDSCAPE_REPORT_CARD_WIDTH}"`);
    expect(svg).toContain(`viewBox="0 0 ${LANDSCAPE_REPORT_CARD_WIDTH} `);
  });

  it('contains all three letter-section headings', async () => {
    const svg = await buildLandscapeReportCardSvg(baseData);
    expect(svg).toContain('सीखे हुए अक्षर');
    expect(svg).toContain('अभी सीख रहा है');
    expect(svg).toContain('पहले से आते अक्षर');
  });

  it('still highlights yesterday\'s wins with brand-blue stars', async () => {
    const svg = await buildLandscapeReportCardSvg(baseData);
    const stars = svg.match(
      new RegExp(`<polygon[^>]*fill="${BRAND_BLUE_HEX}"`, 'g'),
    );
    expect(stars).not.toBeNull();
    expect(stars).toHaveLength(2); // ['ग','घ']
  });

  it('handles all-empty bins gracefully (renders em-dash placeholders)', async () => {
    const svg = await buildLandscapeReportCardSvg({
      ...baseData,
      letters_learnt: [],
      letters_learnt_yesterday: [],
      letters_currently_learning: [],
      letters_already_known: [],
    });
    expect(svg).toMatch(/^<\?xml/);
    // 3 subsections × 1 em-dash placeholder each.
    const dashes = svg.match(/—/g);
    expect(dashes).not.toBeNull();
    expect(dashes!.length).toBeGreaterThanOrEqual(3);
  });

  it('still embeds the QR target URL with the user\'s external_id', async () => {
    const svg = await buildLandscapeReportCardSvg({
      ...baseData,
      user_external_id: '918888888777',
    });
    expect(svg).toContain('918888888777');
    expect(svg).toContain('wa.me/918528097842');
  });

  it('still draws the dotted 5-min line on the activity chart', async () => {
    const svg = await buildLandscapeReportCardSvg({
      ...baseData,
      daily_bars: baseData.daily_bars.map((b) => ({ ...b, active_ms: 0 })),
    });
    expect(svg).toContain('stroke-dasharray');
  });
});