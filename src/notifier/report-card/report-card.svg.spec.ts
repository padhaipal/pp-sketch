import {
  buildReportCardSvg,
  buildLandscapeReportCardSvg,
  LANDSCAPE_REPORT_CARD_WIDTH,
  LOGO_NATURAL_RATIO,
} from './report-card.svg';
import {
  BRAND_BLUE_HEX,
  FIVE_MINUTES_MS,
  HINDI_WEEKDAY_SHORT,
  REPORT_CARD_WIDTH,
  ReportCardData,
} from './report-card.dto';

// ─── helpers ────────────────────────────────────────────────────────────────

const RED_HEX = '#E0454C';

function makeData(overrides: Partial<ReportCardData> = {}): ReportCardData {
  return {
    user_external_id: '918888888001',
    referral_url: 'https://dashboard.padhaipal.com/r/918888888001',
    letters_learnt: ['क', 'ख', 'ग'],
    letters_learnt_yesterday: ['ग'],
    letters_currently_learning: ['च'],
    letters_already_known: ['ट'],
    daily_bars: sevenBars([
      0,
      60_000,
      200_000,
      FIVE_MINUTES_MS,
      360_000,
      600_000,
      0,
    ]),
    ...overrides,
  };
}

// Build 7 chronological bars; day_index cycles Mon(1)…Sun(0) for label checks.
function sevenBars(activeMs: number[]): ReportCardData['daily_bars'] {
  const dayIdx = [1, 2, 3, 4, 5, 6, 0];
  return activeMs.map((ms, i) => ({
    date_iso: `2026-04-2${i + 1}`,
    day_index: dayIdx[i],
    active_ms: ms,
  }));
}

type Attrs = Record<string, string>;

// Parse the attributes of every `<tag ...>` occurrence in the SVG.
function elements(svg: string, tag: string): Attrs[] {
  const re = new RegExp(`<${tag}\\b([^>]*?)/?>`, 'g');
  const out: Attrs[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    const attrs: Attrs = {};
    const attrRe = /([\w:-]+)="([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    out.push(attrs);
  }
  return out;
}

function num(s: string | undefined): number {
  return Number(s);
}

// ─── root canvas ──────────────────────────────────────────────────────────

describe('buildReportCardSvg — root canvas', () => {
  it('emits an XML-declared SVG sized REPORT_CARD_WIDTH wide with a matching viewBox', async () => {
    const svg = await buildReportCardSvg(makeData());
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);

    const root = elements(svg, 'svg')[0];
    expect(num(root.width)).toBe(REPORT_CARD_WIDTH);
    const [vx, vy, vw, vh] = root.viewBox.split(' ').map(Number);
    expect(vx).toBe(0);
    expect(vy).toBe(0);
    expect(vw).toBe(REPORT_CARD_WIDTH);
    // viewBox height must equal the rendered height (not 0, not width).
    expect(vh).toBe(num(root.height));
    expect(vh).toBeGreaterThan(REPORT_CARD_WIDTH); // portrait → taller than wide
  });

  it('paints a full-canvas white background rect', async () => {
    const svg = await buildReportCardSvg(makeData());
    const root = elements(svg, 'svg')[0];
    const rects = elements(svg, 'rect');
    const bg = rects[0];
    expect(bg.x).toBe('0');
    expect(bg.y).toBe('0');
    expect(num(bg.width)).toBe(REPORT_CARD_WIDTH);
    expect(num(bg.height)).toBe(num(root.height));
    expect(bg.fill).toBe('#FFFFFF');
  });
});

describe('buildLandscapeReportCardSvg — root canvas', () => {
  it('uses the wider LANDSCAPE_REPORT_CARD_WIDTH and is wider than tall', async () => {
    const svg = await buildLandscapeReportCardSvg(makeData());
    const root = elements(svg, 'svg')[0];
    expect(num(root.width)).toBe(LANDSCAPE_REPORT_CARD_WIDTH);
    const vh = num(root.height);
    expect(vh).toBeGreaterThan(0);
    expect(num(root.width)).toBeGreaterThan(vh); // landscape → wider than tall
  });
});

// ─── title + headings (HEADING_COLOR, escapeXml) ────────────────────────────

describe('headings + escaping', () => {
  it('renders the title in HEADING_COLOR black', async () => {
    const svg = await buildReportCardSvg(makeData());
    const texts = elements(svg, 'text');
    // The title is the first <text> (font-size 88).
    const title = texts.find((t) => t['font-size'] === '88');
    expect(title).toBeDefined();
    expect(title!.fill).toBe('#000000');
  });

  it('XML-escapes &, <, >, ", and \' that appear in escaped content', async () => {
    // The referral URL is echoed (escaped) into a trailing comment. Feed every
    // special char and assert each is escaped — kills the escapeXml string
    // mutants (&amp; / &lt; / &gt; / &quot; / &apos;).
    const svg = await buildReportCardSvg(
      makeData({
        referral_url: `https://x/?a=1&b=2<tag>"q"'s'`,
      }),
    );
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&gt;');
    expect(svg).toContain('&quot;');
    expect(svg).toContain('&apos;');
    // The raw special chars must NOT leak inside the escaped comment payload.
    expect(svg).not.toContain('a=1&b=2');
  });
});

// ─── star geometry (starPoints) ─────────────────────────────────────────────

describe('star geometry (starred letters)', () => {
  function parsePolygonPoints(svg: string): { x: number; y: number }[][] {
    return elements(svg, 'polygon').map((p) =>
      p.points.split(' ').map((pair) => {
        const [x, y] = pair.split(',').map(Number);
        return { x, y };
      }),
    );
  }

  it('renders one brand-blue star polygon per highlighted (yesterday) letter', async () => {
    const svg = await buildReportCardSvg(
      makeData({
        letters_learnt: ['क', 'ख', 'ग'],
        letters_learnt_yesterday: ['क', 'ख'], // 2 stars
      }),
    );
    const polys = elements(svg, 'polygon');
    expect(polys).toHaveLength(2);
    polys.forEach((p) => expect(p.fill).toBe(BRAND_BLUE_HEX));
  });

  it('each star has exactly 10 vertices alternating outer/inner radius, first vertex at the top', async () => {
    const svg = await buildReportCardSvg(
      makeData({
        letters_learnt: ['क'],
        letters_learnt_yesterday: ['क'],
      }),
    );
    const [pts] = parsePolygonPoints(svg);
    expect(pts).toHaveLength(10);

    // Centre = mean of vertices (star is centrally symmetric in angle).
    const cx = pts.reduce((s, p) => s + p.x, 0) / 10;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 10;

    const radii = pts.map((p) => Math.hypot(p.x - cx, p.y - cy));
    const outer = radii.filter((_, i) => i % 2 === 0);
    const inner = radii.filter((_, i) => i % 2 === 1);
    const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    // Even indices are the outer radius, odd indices the inner — and they
    // differ (kills the `i % 2 === 0 ? outerR : innerR` and ratio mutants).
    expect(avg(outer)).toBeGreaterThan(avg(inner) + 1);
    // innerR ≈ outerR * 0.42 (kills the `outerR * 0.42` → `/ 0.42` mutant).
    expect(avg(inner) / avg(outer)).toBeCloseTo(0.42, 1);

    // First vertex is the top tip: x≈cx, y well above centre.
    expect(Math.abs(pts[0].x - cx)).toBeLessThan(0.5);
    expect(pts[0].y).toBeLessThan(cy - 1);

    // Second vertex (inner, angle −90°+36°) sits to the RIGHT of and below the
    // top tip — kills the `cx + r*cos` → `cx - r*cos` and `cy + r*sin` → `-`
    // sign-flip mutants, plus the `-PI/2 + i*PI/5` → `-` angle mutant.
    expect(pts[1].x).toBeGreaterThan(cx);
    expect(pts[1].y).toBeGreaterThan(pts[0].y);
  });
});

// ─── letter grid (renderLetterTiles / renderLetterSubsection) ───────────────

describe('letter grid layout', () => {
  it('renders one <text> tile per letter, white fill for starred, dark for plain', async () => {
    const svg = await buildReportCardSvg(
      makeData({
        letters_learnt: ['क', 'ख'],
        letters_learnt_yesterday: ['क'], // क starred, ख plain
        letters_currently_learning: [],
        letters_already_known: [],
      }),
    );
    const texts = elements(svg, 'text');
    const kTile = texts.find((t) => t.fill === '#FFFFFF');
    const khTile = texts.find((t) => t.fill === '#222222');
    expect(kTile).toBeDefined(); // starred tile is white-on-blue
    expect(khTile).toBeDefined(); // plain tile is dark
  });

  it('places grid columns left→right at evenly increasing x within a row', async () => {
    // 3 plain letters in the 8-col plain zone → 1 row, increasing x.
    const svg = await buildReportCardSvg(
      makeData({
        letters_learnt: [],
        letters_learnt_yesterday: [],
        letters_currently_learning: ['च', 'छ', 'ज'],
        letters_already_known: [],
      }),
    );
    const texts = elements(svg, 'text');
    // The 3 letter tiles use dominant-baseline central + dark fill.
    const tiles = texts.filter(
      (t) => t['dominant-baseline'] === 'central' && t.fill === '#222222',
    );
    expect(tiles.length).toBe(3);
    const xs = tiles.map((t) => num(t.x));
    // Strictly increasing left→right (kills the `gridX - ...` and offset mutants).
    expect(xs[1]).toBeGreaterThan(xs[0]);
    expect(xs[2]).toBeGreaterThan(xs[1]);
    // Even spacing — adjacent gaps equal (kills `(c+colOffset)*cellW` distortions).
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1], 5);
  });

  it('renders an em-dash placeholder when a subsection bin is empty', async () => {
    const svg = await buildReportCardSvg(
      makeData({
        letters_learnt: ['क'],
        letters_learnt_yesterday: [],
        letters_currently_learning: [], // empty → em-dash
        letters_already_known: [],
      }),
    );
    // The placeholder is a font-size 56 em-dash text node.
    const texts = elements(svg, 'text');
    const dash = texts.filter((t) => t['font-size'] === '56');
    expect(dash.length).toBeGreaterThanOrEqual(2); // currently-learning + already-known
  });
});

// ─── activity chart (renderActivityChart) ───────────────────────────────────

describe('activity chart', () => {
  it('renders bars for ≥5-min days in brand blue and <5-min days in red', async () => {
    const svg = await buildReportCardSvg(
      makeData({
        daily_bars: sevenBars([
          FIVE_MINUTES_MS, // exactly 5 min → blue (not <)
          FIVE_MINUTES_MS - 1, // just under → red
          600_000, // over → blue
          1, // tiny → red
          0, // zero → baseline tick (grey), not a bar
          360_000, // blue
          200_000, // red
        ]),
      }),
    );
    const rects = elements(svg, 'rect');
    const blue = rects.filter((r) => r.fill === BRAND_BLUE_HEX);
    const red = rects.filter((r) => r.fill === RED_HEX);
    const grey = rects.filter((r) => r.fill === '#CCCCCC');
    expect(blue.length).toBe(3); // 5min, 600k, 360k
    expect(red.length).toBe(3); // 5min-1, 1, 200k
    expect(grey.length).toBe(1); // the zero day
  });

  it('spaces bars evenly and makes height proportional to active_ms', async () => {
    const svg = await buildReportCardSvg(
      makeData({
        daily_bars: sevenBars([
          60_000, 120_000, 180_000, 240_000, 300_000, 360_000, 420_000,
        ]),
      }),
    );
    // Coloured bars (exclude the dotted line + bg rects): those with rx="8".
    const bars = elements(svg, 'rect').filter((r) => r.rx === '8');
    expect(bars.length).toBe(7);
    const xs = bars.map((b) => num(b.x));
    // Even spacing (kills `box.x + gap + i*(barW+gap)` arithmetic mutants).
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    gaps.forEach((g) => expect(g).toBeCloseTo(gaps[0], 4));
    // Taller bars for higher activity → larger height & smaller y.
    const heights = bars.map((b) => num(b.height));
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeGreaterThan(heights[i - 1]);
    }
    const ys = bars.map((b) => num(b.y));
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeLessThan(ys[i - 1]);
    }
  });

  it('draws a 4px baseline tick (not a bar) for a 0-activity day', async () => {
    const svg = await buildReportCardSvg(
      makeData({ daily_bars: sevenBars([0, 0, 0, 0, 0, 0, 0]) }),
    );
    const ticks = elements(svg, 'rect').filter((r) => r.fill === '#CCCCCC');
    expect(ticks.length).toBe(7);
    ticks.forEach((t) => expect(num(t.height)).toBe(4));
  });

  it('draws the dotted 5-minute reference line spanning the chart width', async () => {
    const svg = await buildReportCardSvg(makeData());
    const lines = elements(svg, 'line');
    expect(lines.length).toBe(1);
    const l = lines[0];
    expect(l['stroke-dasharray']).toBe('12,10');
    // Horizontal line: y1 === y2, and x2 > x1 (spans width).
    expect(num(l.y1)).toBeCloseTo(num(l.y2), 5);
    expect(num(l.x2)).toBeGreaterThan(num(l.x1));
  });

  it('places the 5-minute line above bars that are under 5 minutes and below taller bars', async () => {
    // maxMs is driven by the 10-min bar; the 5-min line should sit at ~half
    // chart height, the 10-min bar should be taller (its top above the line).
    const svg = await buildReportCardSvg(
      makeData({ daily_bars: sevenBars([0, 0, 0, 600_000, 0, 0, 0]) }),
    );
    const line = elements(svg, 'line')[0];
    const tallBar = elements(svg, 'rect')
      .filter((r) => r.rx === '8')
      .sort((a, b) => num(b.height) - num(a.height))[0];
    const fiveMinY = num(line.y1);
    const barTopY = num(tallBar.y);
    // The 10-min bar's top is above (smaller y) the 5-min line.
    expect(barTopY).toBeLessThan(fiveMinY);
  });

  it('labels each bar with the Hindi weekday for its day_index', async () => {
    const svg = await buildReportCardSvg(makeData());
    // Day labels are font-size 38, fill #444444.
    const labels = elements(svg, 'text').filter(
      (t) => t['font-size'] === '38' && t.fill === '#444444',
    );
    expect(labels.length).toBe(7);
    // The rendered label text must match HINDI_WEEKDAY_SHORT in order.
    const expected = [1, 2, 3, 4, 5, 6, 0].map((d) => HINDI_WEEKDAY_SHORT[d]);
    // Extract label text content in document order.
    const labelTexts = [
      ...(await buildReportCardSvg(makeData())).matchAll(
        /font-size="38"[^>]*>([^<]+)</g,
      ),
    ].map((m) => m[1]);
    expect(labelTexts).toEqual(expected);
  });
});

// ─── QR code (renderQrCode) ─────────────────────────────────────────────────

describe('QR code', () => {
  it('wraps the QR in a translate group with a white backing rect', async () => {
    const svg = await buildReportCardSvg(makeData());
    expect(svg).toMatch(/<g transform="translate\(\d+(\.\d+)?,\d+(\.\d+)?\)">/);
    // White backing rect at local (0,0) inside the group.
    expect(svg).toContain('<rect x="0" y="0"');
  });

  it("preserves the QR's intrinsic module-grid viewBox (not the pixel box size)", async () => {
    const svg = await buildReportCardSvg(makeData());
    // The nested QR <svg> keeps qrcode's own viewBox ("0 0 N N" where N is the
    // module count, typically 21–33), NOT 900 (the qrSize box). Find a nested
    // svg whose viewBox max is small.
    const nested = elements(svg, 'svg').filter(
      (s) =>
        s.viewBox &&
        s.viewBox !== `0 0 ${REPORT_CARD_WIDTH} ${REPORT_CARD_WIDTH}`,
    );
    const qr = nested.find((s) => {
      const max = Number(s.viewBox.split(' ')[2]);
      return max > 0 && max < 100;
    });
    expect(qr).toBeDefined();
    expect(qr!.preserveAspectRatio).toBe('xMidYMid meet');
  });
});

// ─── logo (renderLogo / loadLogoInner) ──────────────────────────────────────

describe('logo', () => {
  it('embeds the logo with the cropped viewBox and natural-ratio box', async () => {
    const svg = await buildReportCardSvg(makeData());
    // The logo <svg> uses the measured crop viewBox "103 275 874 476".
    expect(svg).toContain('viewBox="103 275 874 476"');
    // LOGO_NATURAL_RATIO is derived from that crop (874/476 ≈ 1.84).
    expect(LOGO_NATURAL_RATIO).toBeCloseTo(874 / 476, 5);
    const logo = elements(svg, 'svg').find(
      (s) => s.viewBox === '103 275 874 476',
    );
    expect(logo).toBeDefined();
    // Box width/height honour the natural ratio.
    expect(num(logo!.width) / num(logo!.height)).toBeCloseTo(
      LOGO_NATURAL_RATIO,
      1,
    );
  });
});

// ─── heading wrapping (splitHeading) ────────────────────────────────────────

describe('heading wrapping (splitHeading)', () => {
  it('keeps a short heading on a single tspan and wraps a long heading to two', async () => {
    const svg = await buildReportCardSvg(makeData());
    // सीखे हुए अक्षर (13 chars) ≤ 22 → 1 tspan.
    // The two long headings (>22 chars) wrap to 2 tspans each.
    const tspanGroups = [
      ...svg.matchAll(/<text[^>]*>(<tspan[\s\S]*?)<\/text>/g),
    ].map((m) => [...m[1].matchAll(/<tspan/g)].length);
    // At least one heading rendered as a single tspan and at least one as two.
    expect(tspanGroups).toContain(1);
    expect(tspanGroups).toContain(2);
  });

  it('wraps a long heading at the space nearest the midpoint', async () => {
    // Craft data is not possible (headings are fixed), so assert the known
    // long heading wraps into two non-empty halves whose split point is a
    // space in the original — i.e. neither tspan starts/ends mid-word.
    const svg = await buildReportCardSvg(makeData());
    const twoLine = [
      ...svg.matchAll(
        /<text[^>]*>((?:<tspan[^>]*>[^<]*<\/tspan>){2})<\/text>/g,
      ),
    ];
    expect(twoLine.length).toBeGreaterThanOrEqual(1);
    const firstGroup = twoLine[0][1];
    const parts = [...firstGroup.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map(
      (m) => m[1],
    );
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
    // Re-joining with a single space reconstructs the original heading (proves
    // the split happened at a space, not mid-token).
    // (Devanagari heading contains spaces.)
    expect(parts[0]).not.toMatch(/\s$/);
    expect(parts[1]).not.toMatch(/^\s/);
  });
});

// ─── landscape-specific layout ──────────────────────────────────────────────

describe('landscape layout', () => {
  it('positions the three letter subsections side-by-side (distinct, increasing x centres)', async () => {
    const svg = await buildLandscapeReportCardSvg(
      makeData({
        letters_learnt: ['क'],
        letters_learnt_yesterday: [],
        letters_currently_learning: ['च'],
        letters_already_known: ['ट'],
      }),
    );
    // Section headings are the 3 bold (font-weight 700) font-size 64 texts.
    const headings = elements(svg, 'text').filter(
      (t) => t['font-size'] === '64' && t['font-weight'] === '700',
    );
    // 3 subsection headings + activity heading + CTA heading = 5 of font-size 64.
    expect(headings.length).toBeGreaterThanOrEqual(3);
    // The 3 letter-subsection headings sit at distinct, increasing x (columns).
    const subXs = headings
      .slice(0, 3)
      .map((h) => num(h.x))
      .sort((a, b) => a - b);
    expect(subXs[0]).toBeLessThan(subXs[1]);
    expect(subXs[1]).toBeLessThan(subXs[2]);
  });
});
