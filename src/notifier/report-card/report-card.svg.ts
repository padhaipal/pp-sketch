// The morning report card as an SVG string (rasterised by sharp in
// report-card.service.ts). Portrait 1080 × 1350, Hindi only, drawn with SVG
// primitives — no fonts beyond Noto Sans Devanagari, no images.
//
//   ┌──────────────────────────────┐
//   │ header, band colour          │  "कल", a big face, one praise line
//   │  ◯  praise                   │
//   ├──────────────────────────────┤
//   │ ▌◷ 18 मिनट             ◯    │  time tile, its own face + rail
//   │ ▌▲ +2 स्तर             ◯    │  level tile, its own face + rail
//   │      क    म    त             │  three letters practised most
//   └──────────────────────────────┘

import {
  Band,
  BAND_COLOR_HEX,
  CHIP_NAVY_HEX,
  HINDI_LEVELS,
  HINDI_MINUTES,
  HINDI_YESTERDAY,
  REPORT_CARD_HEIGHT,
  REPORT_CARD_WIDTH,
  ReportCardData,
} from './report-card.dto';

export const FONT = 'Noto Sans Devanagari, sans-serif';

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Layout constants ────────────────────────────────────────────────────────

export const HEADER_HEIGHT = 620;
const HEADER_WORD_Y = 110;
const HEADER_FACE_CY = 330;
const HEADER_FACE_R = 130;
const PRAISE_Y = 560;

const TILE_X = 70;
const TILE_W = REPORT_CARD_WIDTH - 2 * TILE_X;
const TILE_H = 170;
const TILE_GAP = 40;
const TILE_RX = 36;
const TILE_RAIL_W = 28;
export const TIME_TILE_Y = HEADER_HEIGHT + 60;
export const LEVEL_TILE_Y = TIME_TILE_Y + TILE_H + TILE_GAP;
const TILE_FACE_R = 40;

export const CHIP_SIZE = 150;
const CHIP_GAP = 60;
const CHIP_RX = 30;
export const CHIP_Y = LEVEL_TILE_Y + TILE_H + 90;

// ─── Faces ───────────────────────────────────────────────────────────────────

// A face at (cx, cy) with radius r: `fill` is the disc, `ink` the eyes and
// mouth. The mouth is the band — a smile, a flat line, or a frown.
export function renderFace(opts: {
  cx: number;
  cy: number;
  r: number;
  band: Band;
  fill: string;
  ink: string;
}): string {
  const { cx, cy, r, band, fill, ink } = opts;
  const eyeDx = r * 0.38;
  const eyeDy = r * 0.22;
  const eyeR = Math.max(4, r * 0.12);
  const mouthHalf = r * 0.52;
  const mouthY = cy + r * 0.22;
  const bend = r * 0.5;
  const stroke = Math.max(4, r * 0.12);
  const mouth =
    band === 'good'
      ? `M${cx - mouthHalf},${mouthY} Q${cx},${mouthY + bend} ${cx + mouthHalf},${mouthY}`
      : band === 'ok'
        ? `M${cx - mouthHalf},${mouthY + r * 0.12} L${cx + mouthHalf},${mouthY + r * 0.12}`
        : `M${cx - mouthHalf},${mouthY + r * 0.3} Q${cx},${mouthY - bend * 0.6} ${cx + mouthHalf},${mouthY + r * 0.3}`;
  return [
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" data-face="${band}"/>`,
    `<circle cx="${cx - eyeDx}" cy="${cy - eyeDy}" r="${eyeR}" fill="${ink}"/>`,
    `<circle cx="${cx + eyeDx}" cy="${cy - eyeDy}" r="${eyeR}" fill="${ink}"/>`,
    `<path d="${mouth}" stroke="${ink}" stroke-width="${stroke}" stroke-linecap="round" fill="none"/>`,
  ].join('\n');
}

// ─── Tiles ───────────────────────────────────────────────────────────────────

function renderClockIcon(cx: number, cy: number, color: string): string {
  const r = 36;
  return [
    `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="${color}" stroke-width="6" fill="none"/>`,
    `<path d="M${cx},${cy - r + 10} L${cx},${cy} L${cx + r - 12},${cy}" stroke="${color}" stroke-width="6" stroke-linecap="round" fill="none"/>`,
  ].join('\n');
}

function renderLevelIcon(
  cx: number,
  cy: number,
  delta: number,
  color: string,
): string {
  if (delta === 0) {
    return `<rect x="${cx - 24}" y="${cy - 5}" width="48" height="10" rx="5" fill="${color}" data-level-icon="flat"/>`;
  }
  const up = delta > 0;
  const tip = up ? cy - 24 : cy + 24;
  const base = up ? cy + 20 : cy - 20;
  return `<polygon points="${cx - 26},${base} ${cx + 26},${base} ${cx},${tip}" fill="${color}" data-level-icon="${up ? 'up' : 'down'}"/>`;
}

export function renderTile(opts: {
  y: number;
  band: Band;
  icon: string;
  value: string;
  unit: string;
  testId: string;
}): string {
  const { y, band, icon, value, unit, testId } = opts;
  const color = BAND_COLOR_HEX[band];
  const midY = y + TILE_H / 2;
  return [
    `<g data-tile="${testId}" data-band="${band}">`,
    `<rect x="${TILE_X}" y="${y}" width="${TILE_W}" height="${TILE_H}" rx="${TILE_RX}" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-width="4"/>`,
    // coloured rail down the left, inside the border
    `<rect x="${TILE_X + 8}" y="${y + 14}" width="${TILE_RAIL_W}" height="${TILE_H - 28}" rx="${TILE_RAIL_W / 2}" fill="${color}"/>`,
    icon,
    `<text x="${TILE_X + 180}" y="${midY + 30}" font-family="${FONT}" fill="${color}"><tspan font-size="84" font-weight="700">${escapeXml(value)}</tspan><tspan dx="18" font-size="44" font-weight="400" fill="#555555">${escapeXml(unit)}</tspan></text>`,
    renderFace({
      cx: TILE_X + TILE_W - 70,
      cy: midY,
      r: TILE_FACE_R,
      band,
      fill: color,
      ink: '#FFFFFF',
    }),
    `</g>`,
  ].join('\n');
}

export function renderChips(letters: string[]): string {
  if (letters.length === 0) return '';
  const n = letters.length;
  const totalW = n * CHIP_SIZE + (n - 1) * CHIP_GAP;
  const x0 = (REPORT_CARD_WIDTH - totalW) / 2;
  return letters
    .map((letter, i) => {
      const x = x0 + i * (CHIP_SIZE + CHIP_GAP);
      return [
        `<rect x="${x}" y="${CHIP_Y}" width="${CHIP_SIZE}" height="${CHIP_SIZE}" rx="${CHIP_RX}" fill="${CHIP_NAVY_HEX}" data-chip="${escapeXml(letter)}"/>`,
        `<text x="${x + CHIP_SIZE / 2}" y="${CHIP_Y + CHIP_SIZE / 2}" font-size="90" font-weight="700" fill="#FFFFFF" text-anchor="middle" dominant-baseline="central" font-family="${FONT}">${escapeXml(letter)}</text>`,
      ].join('\n');
    })
    .join('\n');
}

export function formatLevelDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

// ─── Card ────────────────────────────────────────────────────────────────────

export function buildReportCardSvg(data: ReportCardData): string {
  const W = REPORT_CARD_WIDTH;
  const H = REPORT_CARD_HEIGHT;
  const cx = W / 2;
  const headerColor = BAND_COLOR_HEX[data.time_band];
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#FFFFFF"/>
  <rect x="0" y="0" width="${W}" height="${HEADER_HEIGHT}" fill="${headerColor}" data-header="${data.time_band}"/>
  <text x="${cx}" y="${HEADER_WORD_Y}" font-size="72" font-weight="700" fill="#FFFFFF" text-anchor="middle" font-family="${FONT}">${escapeXml(HINDI_YESTERDAY)}</text>
  ${renderFace({ cx, cy: HEADER_FACE_CY, r: HEADER_FACE_R, band: data.time_band, fill: '#FFFFFF', ink: headerColor })}
  <text x="${cx}" y="${PRAISE_Y}" font-size="52" font-weight="700" fill="#FFFFFF" text-anchor="middle" font-family="${FONT}" data-praise="1">${escapeXml(data.praise)}</text>
  ${renderTile({
    y: TIME_TILE_Y,
    band: data.time_band,
    icon: renderClockIcon(
      TILE_X + 100,
      TIME_TILE_Y + TILE_H / 2,
      BAND_COLOR_HEX[data.time_band],
    ),
    value: String(data.minutes),
    unit: HINDI_MINUTES,
    testId: 'time',
  })}
  ${renderTile({
    y: LEVEL_TILE_Y,
    band: data.level_band,
    icon: renderLevelIcon(
      TILE_X + 100,
      LEVEL_TILE_Y + TILE_H / 2,
      data.level_delta,
      BAND_COLOR_HEX[data.level_band],
    ),
    value: formatLevelDelta(data.level_delta),
    unit: HINDI_LEVELS,
    testId: 'level',
  })}
  ${renderChips(data.top_letters.slice(0, 3))}
</svg>`;
}
