import * as fs from 'fs';
import * as path from 'path';
import * as QRCode from 'qrcode';
import {
  BRAND_BLUE_HEX,
  DailyBar,
  FIVE_MINUTES_MS,
  HINDI_ACTIVITY_HEADING,
  HINDI_ALREADY_KNOWN_HEADING,
  HINDI_CURRENTLY_LEARNING_HEADING,
  HINDI_LETTERS_HEADING,
  HINDI_TITLE,
  HINDI_TRY_NOW,
  HINDI_WEEKDAY_SHORT,
  LETTERS_SECTION_BG_HEX,
  REPORT_CARD_WIDTH,
  ReportCardData,
} from './report-card.dto';

// __dirname resolves to:
//   dev   → src/notifier/report-card  (ts-node)
//   prod  → dist/notifier/report-card (compiled)
// nest-cli.json copies src/assets/** into dist/assets, so this single path
// works for both runtimes.
const LOGO_PATH = path.resolve(
  __dirname,
  '../../assets/branding/padhaipal-logo.svg',
);

let cachedLogoInner: string | null = null;

function loadLogoInner(): string {
  if (cachedLogoInner !== null) return cachedLogoInner;
  const raw = fs.readFileSync(LOGO_PATH, 'utf8');
  // Strip the outer <svg ...> wrapper so we can place the inner content inside
  // a <g transform="..."> element.
  const openMatch = raw.match(/<svg\b[^>]*>/);
  const closeMatch = raw.lastIndexOf('</svg>');
  if (!openMatch || closeMatch < 0) {
    throw new Error('logo svg: malformed <svg> wrapper');
  }
  const start = openMatch.index! + openMatch[0].length;
  cachedLogoInner = raw.slice(start, closeMatch);
  return cachedLogoInner;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}


interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── Typography scale ──────────────────────────────────────────────────────
const TITLE_FONT_SIZE = 88;
const SECTION_HEADING_FONT_SIZE = 64; // smaller than title
const DAY_LABEL_FONT_SIZE = 38;
const LETTER_FONT_CAP = 70;

// Single colour for the title, the activity heading, all letter subsection
// headings, and the CTA "पढ़ाईपाल अभी आज़माएं!" — uniform black per spec.
const HEADING_COLOR = '#000000';

// ─── Letter grid ───────────────────────────────────────────────────────────
// Two-zone grid: starred letters render in a 4-col × 220 px square layout
// (room for the star polygon). Plain (non-starred) letters bunch into an
// 8-col × 130 px tighter layout below — same column width × ½ cell height,
// so the same total grid width but ~½ the vertical real estate per row.
const LETTER_GRID_HIGHLIGHTED_COLS = 4;
const LETTER_GRID_HIGHLIGHTED_CELL = 220;
const LETTER_GRID_PLAIN_COLS = 8;
const LETTER_GRID_PLAIN_CELL_H = 130;
// Vertical gap between the highlighted (starred) row(s) and the plain rows.
const LETTER_GRID_HI_TO_PLAIN_GAP = 30;

// Returns the 10 (x,y) vertices of a 5-pointed star centered at (cx,cy),
// alternating outer and inner radii, starting from the top tip. Inner-to-outer
// ratio of 0.42 keeps the points chunky enough that the Devanagari glyph on
// top doesn't clip into the concavities.
function starPoints(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? outerR : innerR;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(' ');
}

// Renders a contiguous block of letter tiles (one row of cells per chunk of
// `cols`). `withStars` controls whether each tile gets a brand-blue star
// behind the letter — used by the "today's wins" zone of the सीखे हुए अक्षर
// subsection. Returns the rendered SVG plus the y-coordinate just below the
// last row so the caller can keep stacking content underneath.
function renderLetterTiles(opts: {
  letters: string[];
  topY: number;
  gridX: number;
  gridWidth: number;
  cols: number;
  cellH: number;
  fontCap: number;
  withStars: boolean;
}): { svg: string; bottomY: number } {
  if (opts.letters.length === 0) {
    return { svg: '', bottomY: opts.topY };
  }
  const rows = Math.ceil(opts.letters.length / opts.cols);
  const cellW = opts.gridWidth / opts.cols;
  const fontSize = Math.min(opts.cellH * 0.7, opts.fontCap);
  // Centre any partial last row by shifting columns by half the empty-cell
  // count. Full rows (all preceding rows + a last row that fills) get
  // offset 0 and render unchanged.
  const lastRowStart = (rows - 1) * opts.cols;
  const lastRowCount = opts.letters.length - lastRowStart;
  const lastRowOffset = (opts.cols - lastRowCount) / 2;
  const tiles: string[] = [];
  opts.letters.forEach((letter, i) => {
    const r = Math.floor(i / opts.cols);
    const c = i % opts.cols;
    const colOffset = i >= lastRowStart ? lastRowOffset : 0;
    const cx = opts.gridX + (c + colOffset) * cellW + cellW / 2;
    const cy = opts.topY + r * opts.cellH + opts.cellH / 2;
    if (opts.withStars) {
      const outerR = Math.min(cellW, opts.cellH) * 0.48;
      const innerR = outerR * 0.42;
      tiles.push(
        `<polygon points="${starPoints(cx, cy, outerR, innerR)}" fill="${BRAND_BLUE_HEX}" />`,
      );
    }
    const fill = opts.withStars ? '#FFFFFF' : '#222222';
    tiles.push(
      `<text x="${cx}" y="${cy}" font-size="${fontSize}" fill="${fill}" text-anchor="middle" dominant-baseline="central" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(letter)}</text>`,
    );
  });
  return {
    svg: tiles.join('\n'),
    bottomY: opts.topY + rows * opts.cellH,
  };
}

function renderActivityChart(bars: DailyBar[], box: LayoutBox): string {
  const minBars = Math.max(bars.length, 1);
  const gap = 18;
  const barW = (box.width - gap * (minBars + 1)) / minBars;

  const maxMs = Math.max(
    FIVE_MINUTES_MS, // ensure 5-min line is always within the visible scale
    ...bars.map((b) => b.active_ms),
    1,
  );

  // Reserve room for x-axis labels under the bars.
  const labelArea = 64;
  const chartH = box.height - labelArea;
  const baselineY = box.y + chartH;

  const lines: string[] = [];
  bars.forEach((b, i) => {
    const x = box.x + gap + i * (barW + gap);
    const ratio = b.active_ms / maxMs;
    const h = Math.max(0, ratio * chartH);
    const y = baselineY - h;
    const fill = b.active_ms < FIVE_MINUTES_MS ? '#E0454C' : BRAND_BLUE_HEX;
    if (h > 0) {
      lines.push(
        `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="8" ry="8" fill="${fill}" />`,
      );
    } else {
      // 0-height: thin baseline tick so the day still reads as "present".
      lines.push(
        `<rect x="${x}" y="${baselineY - 4}" width="${barW}" height="4" rx="2" ry="2" fill="#CCCCCC" />`,
      );
    }
    const label = HINDI_WEEKDAY_SHORT[b.day_index] ?? '';
    lines.push(
      `<text x="${x + barW / 2}" y="${baselineY + 44}" font-size="${DAY_LABEL_FONT_SIZE}" fill="#444444" text-anchor="middle" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(label)}</text>`,
    );
  });

  // Dotted 5-minute line — unmarked.
  const fiveMinY = baselineY - (FIVE_MINUTES_MS / maxMs) * chartH;
  lines.push(
    `<line x1="${box.x}" y1="${fiveMinY}" x2="${box.x + box.width}" y2="${fiveMinY}" stroke="#888888" stroke-width="3" stroke-dasharray="12,10" />`,
  );

  return lines.join('\n');
}

function renderQrCode(qrSvg: string, box: LayoutBox): string {
  // qrcode.toString outputs a complete <svg> with its own viewBox sized to
  // the module grid (e.g. "0 0 33 33" for a 33-module QR). We strip the
  // outer wrapper but PRESERVE that intrinsic viewBox so we can scale it
  // to fill our target box. Earlier code used "0 0 ${qrSize} ${qrSize}" as
  // the viewBox, which made the QR render at native module-pixel size and
  // appear tiny inside the wrapper.
  const open = qrSvg.match(/<svg\b[^>]*>/);
  const close = qrSvg.lastIndexOf('</svg>');
  let qrInner = qrSvg;
  let qrViewBox = `0 0 ${box.width} ${box.height}`;
  if (open && close >= 0) {
    qrInner = qrSvg.slice(open.index! + open[0].length, close);
    const vbMatch = open[0].match(/viewBox="([^"]+)"/);
    if (vbMatch) qrViewBox = vbMatch[1];
  }
  return [
    `<g transform="translate(${box.x},${box.y})">`,
    `<rect x="0" y="0" width="${box.width}" height="${box.height}" fill="#FFFFFF" />`,
    `<svg width="${box.width}" height="${box.height}" viewBox="${qrViewBox}" preserveAspectRatio="xMidYMid meet">${qrInner}</svg>`,
    `</g>`,
  ].join('\n');
}

// Visible bbox of the wing+wordmark inside the source 1080×1080 SVG.
// Measured by reading the rendered alpha channel and finding the tightest
// rectangle of pixels with alpha > 5 — sharp's default `trim()` was clipping
// ~27 px of the wing's anti-aliased top edge. Plus 5 px of safety padding
// on each side so a future tweak to font hinting / rasteriser doesn't bite
// us.
const LOGO_VIEWBOX_X = 103;
const LOGO_VIEWBOX_Y = 275;
const LOGO_VIEWBOX_W = 874;
const LOGO_VIEWBOX_H = 476;
export const LOGO_NATURAL_RATIO = LOGO_VIEWBOX_W / LOGO_VIEWBOX_H; // ≈ 1.84

function renderLogo(box: LayoutBox): string {
  const inner = loadLogoInner();
  // Nested <svg> so we can apply a cropped viewBox; preserveAspectRatio meet
  // letterboxes if the box's aspect ratio doesn't match the artwork's.
  return `<svg x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" viewBox="${LOGO_VIEWBOX_X} ${LOGO_VIEWBOX_Y} ${LOGO_VIEWBOX_W} ${LOGO_VIEWBOX_H}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}

// Splits a heading string into at most 2 lines at the space closest to the
// midpoint, so headings longer than ~24 chars wrap rather than overflow the
// 1080-wide canvas at SECTION_HEADING_FONT_SIZE.
function splitHeading(text: string, maxCharsSingleLine: number): string[] {
  if (text.length <= maxCharsSingleLine) return [text];
  const mid = Math.floor(text.length / 2);
  let best = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) {
      best = i;
    }
  }
  if (best < 0) return [text];
  return [text.slice(0, best), text.slice(best + 1)];
}

const HEADING_LINE_HEIGHT = SECTION_HEADING_FONT_SIZE * 1.25;
const SUBSECTION_INNER_GAP = 60; // grid bottom → next subsection top
const HEADING_TO_GRID_GAP = 50;
const HEADING_SINGLE_LINE_MAX_CHARS = 22;

interface SubsectionResult {
  svg: string;
  bottomY: number;
}

// Renders one (heading + letter-grid) subsection inside the letters panel.
// The heading is centred and may wrap to 2 lines. The grid splits letters
// into a "starred" zone (4-col × 220 cells) and a "plain" zone (8-col × 130
// cells) — non-starred letters bunch into the tighter zone underneath, so
// users with lots of mastered letters don't fill half a screen.
function renderLetterSubsection(opts: {
  heading: string;
  letters: string[];
  highlighted: Set<string>;
  cx: number;
  topY: number;
  gridX: number;
  gridWidth: number;
}): SubsectionResult {
  const lines = splitHeading(opts.heading, HEADING_SINGLE_LINE_MAX_CHARS);
  const headingFirstBaseline = opts.topY + SECTION_HEADING_FONT_SIZE;
  const headingLastBaseline =
    headingFirstBaseline + (lines.length - 1) * HEADING_LINE_HEIGHT;

  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${opts.cx}" dy="${i === 0 ? 0 : HEADING_LINE_HEIGHT}">${escapeXml(line)}</tspan>`,
    )
    .join('');
  const headingSvg = `<text x="${opts.cx}" y="${headingFirstBaseline}" font-size="${SECTION_HEADING_FONT_SIZE}" fill="${HEADING_COLOR}" font-weight="700" text-anchor="middle" font-family="Noto Sans Devanagari, sans-serif">${tspans}</text>`;

  const gridY = headingLastBaseline + HEADING_TO_GRID_GAP;

  // Empty bin → em-dash placeholder, sized to one plain-zone row so the
  // panel keeps a consistent rhythm.
  if (opts.letters.length === 0) {
    const emDashY = gridY + LETTER_GRID_PLAIN_CELL_H / 2;
    const placeholder = `<text x="${opts.cx}" y="${emDashY}" font-size="56" fill="#888888" text-anchor="middle" dominant-baseline="central" font-family="Noto Sans Devanagari, sans-serif">—</text>`;
    return {
      svg: `${headingSvg}\n${placeholder}`,
      bottomY: gridY + LETTER_GRID_PLAIN_CELL_H,
    };
  }

  const starred = opts.letters.filter((l) => opts.highlighted.has(l));
  const plain = opts.letters.filter((l) => !opts.highlighted.has(l));

  let cursor = gridY;
  const tiles: string[] = [headingSvg];

  if (starred.length > 0) {
    const r = renderLetterTiles({
      letters: starred,
      topY: cursor,
      gridX: opts.gridX,
      gridWidth: opts.gridWidth,
      cols: LETTER_GRID_HIGHLIGHTED_COLS,
      cellH: LETTER_GRID_HIGHLIGHTED_CELL,
      fontCap: LETTER_FONT_CAP,
      withStars: true,
    });
    tiles.push(r.svg);
    cursor = r.bottomY;
    if (plain.length > 0) cursor += LETTER_GRID_HI_TO_PLAIN_GAP;
  }

  if (plain.length > 0) {
    const r = renderLetterTiles({
      letters: plain,
      topY: cursor,
      gridX: opts.gridX,
      gridWidth: opts.gridWidth,
      cols: LETTER_GRID_PLAIN_COLS,
      cellH: LETTER_GRID_PLAIN_CELL_H,
      fontCap: LETTER_FONT_CAP,
      withStars: false,
    });
    tiles.push(r.svg);
    cursor = r.bottomY;
  }

  return { svg: tiles.join('\n'), bottomY: cursor };
}

export async function buildReportCardSvg(
  data: ReportCardData,
): Promise<string> {
  const referralUrl = data.referral_url;
  const qrSvg = await QRCode.toString(referralUrl, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  const W = REPORT_CARD_WIDTH;
  const cx = W / 2;

  // ── Section spacing ──
  // SECTION_PADDING_Y is applied (a) inside each coloured band as top/bottom
  // padding, and (b) as gap between adjacent bands. Larger value → more
  // vertical breathing room between sections.
  const SECTION_PADDING_Y = 100;
  const LOGO_TO_TITLE_GAP = 30;

  // ── Logo (cropped viewBox; box matches the artwork's natural ratio so the
  // box bottom == the bottom of the visible artwork) ──
  const logoWidth = 720;
  const logoHeight = Math.round(logoWidth / LOGO_NATURAL_RATIO);
  const logoBox: LayoutBox = {
    x: (W - logoWidth) / 2,
    y: SECTION_PADDING_Y / 2,
    width: logoWidth,
    height: logoHeight,
  };

  // ── Centred title, just below the logo's visible bottom ──
  const titleBaselineY =
    logoBox.y + logoBox.height + LOGO_TO_TITLE_GAP + TITLE_FONT_SIZE;

  // ── Letters section: 3 stacked subsections wrapped in a light-blue panel ──
  const lettersSectionTop = titleBaselineY + SECTION_PADDING_Y;
  const gridX = 100;
  const gridWidth = W - 200;

  const highlighted = new Set(data.letters_learnt_yesterday);
  const sub1 = renderLetterSubsection({
    heading: HINDI_LETTERS_HEADING,
    letters: data.letters_learnt,
    highlighted,
    cx,
    topY: lettersSectionTop + 30,
    gridX,
    gridWidth,
  });
  const sub2 = renderLetterSubsection({
    heading: HINDI_CURRENTLY_LEARNING_HEADING,
    letters: data.letters_currently_learning,
    highlighted: new Set(),
    cx,
    topY: sub1.bottomY + SUBSECTION_INNER_GAP,
    gridX,
    gridWidth,
  });
  const sub3 = renderLetterSubsection({
    heading: HINDI_ALREADY_KNOWN_HEADING,
    letters: data.letters_already_known,
    highlighted: new Set(),
    cx,
    topY: sub2.bottomY + SUBSECTION_INNER_GAP,
    gridX,
    gridWidth,
  });
  const lettersSectionBottom = sub3.bottomY + 40;

  // White carve-out for sub2 (सीख रहा है) — centred between sub1 and sub3 in
  // the surrounding gaps so all three sub-section gaps look symmetric.
  const sub2WhiteTop = sub1.bottomY + SUBSECTION_INNER_GAP / 2;
  const sub2WhiteBottom = sub2.bottomY + SUBSECTION_INNER_GAP / 2;

  // ── Activity section ──
  const activitySectionTop = lettersSectionBottom + SECTION_PADDING_Y;
  const activityHeadingBaselineY =
    activitySectionTop + SECTION_HEADING_FONT_SIZE;
  const activityChart: LayoutBox = {
    x: 80,
    y: activityHeadingBaselineY + 50,
    width: W - 160,
    height: 360,
  };

  // ── CTA + QR (centred, on a full-bleed light-blue panel) ──
  const ctaSectionTop =
    activityChart.y + activityChart.height + SECTION_PADDING_Y;
  const ctaBaselineY = ctaSectionTop + 30 + SECTION_HEADING_FONT_SIZE;
  const qrSize = 900;
  const qrBox: LayoutBox = {
    x: (W - qrSize) / 2,
    y: ctaBaselineY + 50,
    width: qrSize,
    height: qrSize,
  };

  // Bottom padding inside the CTA panel mirrors the top padding for symmetry.
  const H = qrBox.y + qrBox.height + SECTION_PADDING_Y;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#FF0000" />

  ${renderLogo(logoBox)}

  <text x="${cx}" y="${titleBaselineY}" font-size="${TITLE_FONT_SIZE}" fill="${HEADING_COLOR}" font-weight="700" text-anchor="middle" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(HINDI_TITLE)}</text>

  <!-- Letters section (full-bleed light background, with a white carve-out
       behind the सीख रहा है subsection so the three subsections alternate
       blue-white-blue). -->
  <rect x="0" y="${lettersSectionTop}" width="${W}" height="${lettersSectionBottom - lettersSectionTop}" fill="${LETTERS_SECTION_BG_HEX}" />
  <rect x="0" y="${sub2WhiteTop}" width="${W}" height="${sub2WhiteBottom - sub2WhiteTop}" fill="#FFFFFF" />
  ${sub1.svg}
  ${sub2.svg}
  ${sub3.svg}

  <!-- Activity section -->
  <text x="${cx}" y="${activityHeadingBaselineY}" font-size="${SECTION_HEADING_FONT_SIZE}" fill="${HEADING_COLOR}" font-weight="700" text-anchor="middle" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(HINDI_ACTIVITY_HEADING)}</text>
  ${renderActivityChart(data.daily_bars, activityChart)}

  <!-- CTA + QR (centred, full-bleed light-blue panel matching the letters section) -->
  <rect x="0" y="${ctaSectionTop}" width="${W}" height="${H - ctaSectionTop}" fill="${LETTERS_SECTION_BG_HEX}" />
  <text x="${cx}" y="${ctaBaselineY}" font-size="${SECTION_HEADING_FONT_SIZE}" fill="${HEADING_COLOR}" font-weight="700" text-anchor="middle" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(HINDI_TRY_NOW)}</text>
  ${renderQrCode(qrSvg, qrBox)}

  <!-- referral target: ${escapeXml(referralUrl)} -->
</svg>`;
}

// ─── Landscape variant ─────────────────────────────────────────────────────
// Wider canvas with the three letter subsections side-by-side, and the
// activity chart + QR sitting side-by-side below them. Reuses every shared
// primitive (renderLogo, renderLetterSubsection, renderActivityChart,
// renderQrCode) — only the coordinate layout changes.
export const LANDSCAPE_REPORT_CARD_WIDTH = 2400;

export async function buildLandscapeReportCardSvg(
  data: ReportCardData,
): Promise<string> {
  const referralUrl = data.referral_url;
  const qrSvg = await QRCode.toString(referralUrl, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  const W = LANDSCAPE_REPORT_CARD_WIDTH;
  const cx = W / 2;

  const SECTION_PADDING_Y = 100;
  const ROW_PAD_X = 60;
  const COLUMN_GAP = 80;
  const LOGO_TO_TITLE_GAP = 30;

  // ── Logo + title centred at the top ──
  const logoWidth = 540; // smaller than portrait — there's less vertical room
  const logoHeight = Math.round(logoWidth / LOGO_NATURAL_RATIO);
  const logoBox: LayoutBox = {
    x: (W - logoWidth) / 2,
    y: SECTION_PADDING_Y / 2,
    width: logoWidth,
    height: logoHeight,
  };
  const titleBaselineY =
    logoBox.y + logoBox.height + LOGO_TO_TITLE_GAP + TITLE_FONT_SIZE;

  // ── Letters row: 3 subsections side-by-side ──
  // Available width minus outer padding minus 2 inter-column gaps,
  // divided into 3 equal columns.
  const subWidth = Math.floor((W - 2 * ROW_PAD_X - 2 * COLUMN_GAP) / 3);
  const lettersRowTop = titleBaselineY + SECTION_PADDING_Y;
  const sub1X = ROW_PAD_X;
  const sub2X = sub1X + subWidth + COLUMN_GAP;
  const sub3X = sub2X + subWidth + COLUMN_GAP;
  const sub1Cx = sub1X + subWidth / 2;
  const sub2Cx = sub2X + subWidth / 2;
  const sub3Cx = sub3X + subWidth / 2;

  // Column order (left → right): अभी सीख रहा है | सीखे हुए अक्षर | पहले से आते अक्षर.
  // The "today's wins" highlights live in सीखे हुए अक्षर (bin 3), which sits in
  // the middle column for the landscape variant.
  const highlighted = new Set(data.letters_learnt_yesterday);
  const sub1 = renderLetterSubsection({
    heading: HINDI_CURRENTLY_LEARNING_HEADING,
    letters: data.letters_currently_learning,
    highlighted: new Set(),
    cx: sub1Cx,
    topY: lettersRowTop + 30,
    gridX: sub1X,
    gridWidth: subWidth,
  });
  const sub2 = renderLetterSubsection({
    heading: HINDI_LETTERS_HEADING,
    letters: data.letters_learnt,
    highlighted,
    cx: sub2Cx,
    topY: lettersRowTop + 30,
    gridX: sub2X,
    gridWidth: subWidth,
  });
  const sub3 = renderLetterSubsection({
    heading: HINDI_ALREADY_KNOWN_HEADING,
    letters: data.letters_already_known,
    highlighted: new Set(),
    cx: sub3Cx,
    topY: lettersRowTop + 30,
    gridX: sub3X,
    gridWidth: subWidth,
  });
  const lettersRowBottom =
    Math.max(sub1.bottomY, sub2.bottomY, sub3.bottomY) + 40;

  // ── Bottom row: activity chart (left) + CTA/QR (right) ──
  const bottomRowTop = lettersRowBottom + SECTION_PADDING_Y;
  const qrSize = 600;
  const qrAreaWidth = qrSize + 100; // 50 px breathing room each side
  const activityAreaWidth =
    W - 2 * ROW_PAD_X - qrAreaWidth - COLUMN_GAP;
  const activityAreaX = ROW_PAD_X;
  const qrAreaX = activityAreaX + activityAreaWidth + COLUMN_GAP;
  const activityCx = activityAreaX + activityAreaWidth / 2;
  const qrAreaCx = qrAreaX + qrAreaWidth / 2;

  const activityHeadingBaselineY = bottomRowTop + SECTION_HEADING_FONT_SIZE;
  const activityChart: LayoutBox = {
    x: activityAreaX,
    y: activityHeadingBaselineY + 50,
    width: activityAreaWidth,
    height: 540,
  };

  // CTA shares the section-heading font size — uniform per spec.
  const ctaBaselineY = bottomRowTop + SECTION_HEADING_FONT_SIZE;
  const qrBox: LayoutBox = {
    x: qrAreaCx - qrSize / 2,
    y: ctaBaselineY + 50,
    width: qrSize,
    height: qrSize,
  };

  const bottomRowBottom = Math.max(
    activityChart.y + activityChart.height,
    qrBox.y + qrBox.height,
  );
  const H = bottomRowBottom + SECTION_PADDING_Y;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#FF0000" />

  ${renderLogo(logoBox)}

  <text x="${cx}" y="${titleBaselineY}" font-size="${TITLE_FONT_SIZE}" fill="${HEADING_COLOR}" font-weight="700" text-anchor="middle" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(HINDI_TITLE)}</text>

  <!-- Letters row (uniform light-blue background across all three subsections) -->
  <rect x="0" y="${lettersRowTop}" width="${W}" height="${lettersRowBottom - lettersRowTop}" fill="${LETTERS_SECTION_BG_HEX}" />
  ${sub1.svg}
  ${sub2.svg}
  ${sub3.svg}

  <!-- Bottom row: activity chart on the left, CTA + QR on the right (white background throughout) -->
  <text x="${activityCx}" y="${activityHeadingBaselineY}" font-size="${SECTION_HEADING_FONT_SIZE}" fill="${HEADING_COLOR}" font-weight="700" text-anchor="middle" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(HINDI_ACTIVITY_HEADING)}</text>
  ${renderActivityChart(data.daily_bars, activityChart)}

  <text x="${qrAreaCx}" y="${ctaBaselineY}" font-size="${SECTION_HEADING_FONT_SIZE}" fill="${HEADING_COLOR}" font-weight="700" text-anchor="middle" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(HINDI_TRY_NOW)}</text>
  ${renderQrCode(qrSvg, qrBox)}

  <!-- referral target: ${escapeXml(referralUrl)} -->
</svg>`;
}