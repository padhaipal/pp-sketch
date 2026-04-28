import * as fs from 'fs';
import * as path from 'path';
import * as QRCode from 'qrcode';
import {
  BRAND_BLUE_HEX,
  DailyBar,
  FIVE_MINUTES_MS,
  HINDI_ACTIVITY_HEADING,
  HINDI_LETTERS_HEADING,
  HINDI_TITLE,
  HINDI_TRY_NOW,
  HINDI_WEEKDAY_SHORT,
  REPORT_CARD_HEIGHT,
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
  // a <g transform="..."> element. The first <svg ...> opening tag is removed
  // and so is the final </svg>.
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

function buildReferralUrl(userExternalId: string): string {
  // The Hindi text payload is fixed (per spec, with {phonenumber} substituted).
  const template =
    'मुझे {phonenumber} ने रेफर किया है। पढ़ना सीखने में रुचि है';
  const text = template.replace('{phonenumber}', userExternalId);
  return `https://wa.me/918528097842?text=${encodeURIComponent(text)}`;
}

interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function renderLetterGrid(
  letters: string[],
  highlighted: Set<string>,
  box: LayoutBox,
): string {
  if (letters.length === 0) {
    return `<text x="${box.x + box.width / 2}" y="${box.y + box.height / 2}" font-size="44" fill="#888888" text-anchor="middle" font-family="Noto Sans Devanagari, sans-serif">—</text>`;
  }
  const cols = 8;
  const rows = Math.ceil(letters.length / cols);
  const cellW = box.width / cols;
  const cellH = Math.min(box.height / Math.max(rows, 1), 110);
  const fontSize = Math.min(cellH * 0.7, 64);
  const tiles: string[] = [];
  letters.forEach((letter, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const cx = box.x + c * cellW + cellW / 2;
    const cy = box.y + r * cellH + cellH / 2;
    const isHighlight = highlighted.has(letter);
    if (isHighlight) {
      const radius = Math.min(cellW, cellH) * 0.42;
      tiles.push(
        `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${BRAND_BLUE_HEX}" />`,
      );
    }
    const fill = isHighlight ? '#FFFFFF' : '#222222';
    tiles.push(
      `<text x="${cx}" y="${cy}" font-size="${fontSize}" fill="${fill}" text-anchor="middle" dominant-baseline="central" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(letter)}</text>`,
    );
  });
  return tiles.join('\n');
}

function renderActivityChart(bars: DailyBar[], box: LayoutBox): string {
  const minBars = Math.max(bars.length, 1);
  const gap = 16;
  const barW = (box.width - gap * (minBars + 1)) / minBars;

  const maxMs = Math.max(
    FIVE_MINUTES_MS, // ensure 5-min line is always within the visible scale
    ...bars.map((b) => b.active_ms),
    1,
  );

  // Reserve room for x-axis labels under the bars.
  const labelArea = 56;
  const chartH = box.height - labelArea;
  const baselineY = box.y + chartH;

  const lines: string[] = [];
  // Bars
  bars.forEach((b, i) => {
    const x = box.x + gap + i * (barW + gap);
    const ratio = b.active_ms / maxMs;
    const h = Math.max(0, ratio * chartH);
    const y = baselineY - h;
    const fill = b.active_ms < FIVE_MINUTES_MS ? '#E0454C' : BRAND_BLUE_HEX;
    if (h > 0) {
      lines.push(
        `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="6" ry="6" fill="${fill}" />`,
      );
    } else {
      // 0-height: draw a thin baseline tick so the day still reads as "present".
      lines.push(
        `<rect x="${x}" y="${baselineY - 4}" width="${barW}" height="4" rx="2" ry="2" fill="#CCCCCC" />`,
      );
    }
    // Hindi day label.
    const label = HINDI_WEEKDAY_SHORT[b.day_index] ?? '';
    lines.push(
      `<text x="${x + barW / 2}" y="${baselineY + 36}" font-size="30" fill="#444444" text-anchor="middle" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(label)}</text>`,
    );
  });

  // Dotted 5-minute line — unmarked.
  const fiveMinY = baselineY - (FIVE_MINUTES_MS / maxMs) * chartH;
  lines.push(
    `<line x1="${box.x}" y1="${fiveMinY}" x2="${box.x + box.width}" y2="${fiveMinY}" stroke="#888888" stroke-width="3" stroke-dasharray="10,8" />`,
  );

  return lines.join('\n');
}

function renderQrBlock(
  userExternalId: string,
  qrSvg: string,
  box: LayoutBox,
): string {
  // Strip QR inner content out of its <svg> wrapper so we can place at given xy.
  const open = qrSvg.match(/<svg\b[^>]*>/);
  const close = qrSvg.lastIndexOf('</svg>');
  let qrInner = qrSvg;
  if (open && close >= 0) {
    qrInner = qrSvg.slice(open.index! + open[0].length, close);
  }
  // qrcode.toString() emits a 0..N viewBox with built-in margin.
  const qrSize = box.height;
  const qrX = box.x + box.width - qrSize;
  const qrY = box.y;

  const text = HINDI_TRY_NOW;
  const textBoxW = box.width - qrSize - 40;
  const textCenterX = box.x + textBoxW / 2;
  const textCenterY = box.y + box.height / 2;

  return [
    `<g transform="translate(${qrX},${qrY})">`,
    `<rect x="0" y="0" width="${qrSize}" height="${qrSize}" fill="#FFFFFF" />`,
    `<svg width="${qrSize}" height="${qrSize}" viewBox="0 0 ${qrSize} ${qrSize}" preserveAspectRatio="xMidYMid meet">${qrInner}</svg>`,
    `</g>`,
    `<text x="${textCenterX}" y="${textCenterY}" font-size="44" fill="${BRAND_BLUE_HEX}" font-weight="700" text-anchor="middle" dominant-baseline="central" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(text)}</text>`,
    // The hint phone number is encoded in the QR; nothing else to render.
    // We deliberately don't render the wa.me URL textually to keep the card clean.
    `<!-- referral target: ${escapeXml(buildReferralUrl(userExternalId))} -->`,
  ].join('\n');
}

function renderLogo(box: LayoutBox): string {
  const inner = loadLogoInner();
  // Source viewBox is 0 0 1080 1080.
  const scale = box.width / 1080;
  return `<g transform="translate(${box.x},${box.y}) scale(${scale})">${inner}</g>`;
}

export async function buildReportCardSvg(
  data: ReportCardData,
): Promise<string> {
  const referralUrl = buildReferralUrl(data.user_external_id);
  const qrSvg = await QRCode.toString(referralUrl, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  const W = REPORT_CARD_WIDTH;
  const H = REPORT_CARD_HEIGHT;

  const titleY = 80;
  const logoBox: LayoutBox = { x: W - 220, y: 30, width: 180, height: 180 };

  const lettersHeading: LayoutBox = {
    x: 60,
    y: 240,
    width: W - 120,
    height: 60,
  };
  const lettersGrid: LayoutBox = {
    x: 60,
    y: 320,
    width: W - 120,
    height: 380,
  };

  const activityHeading: LayoutBox = {
    x: 60,
    y: 740,
    width: W - 120,
    height: 60,
  };
  const activityChart: LayoutBox = {
    x: 60,
    y: 820,
    width: W - 120,
    height: 280,
  };

  const qrBlock: LayoutBox = { x: 60, y: 1140, width: W - 120, height: 180 };

  const highlighted = new Set(data.letters_learnt_yesterday);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#FFFFFF" />

  ${renderLogo(logoBox)}

  <text x="60" y="${titleY}" font-size="64" fill="#222222" font-weight="700" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(HINDI_TITLE)}</text>

  <text x="${lettersHeading.x}" y="${lettersHeading.y + 44}" font-size="40" fill="#444444" font-weight="600" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(HINDI_LETTERS_HEADING)}</text>
  ${renderLetterGrid(data.letters_learnt, highlighted, lettersGrid)}

  <text x="${activityHeading.x}" y="${activityHeading.y + 44}" font-size="40" fill="#444444" font-weight="600" font-family="Noto Sans Devanagari, sans-serif">${escapeXml(HINDI_ACTIVITY_HEADING)}</text>
  ${renderActivityChart(data.daily_bars, activityChart)}

  ${renderQrBlock(data.user_external_id, qrSvg, qrBlock)}
</svg>`;
}