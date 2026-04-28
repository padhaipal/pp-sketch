// Smoke-test the report-card renderer with fake data — no DB, no Redis, no Nest.
// Run: npx ts-node -r tsconfig-paths/register scripts/render-report-card.ts
// Outputs: /tmp/report-card.svg + /tmp/report-card.png

import * as fs from 'fs';
import sharp from 'sharp';
import { buildReportCardSvg } from '../src/notifier/report-card/report-card.svg';
import {
  FIVE_MINUTES_MS,
  ReportCardData,
} from '../src/notifier/report-card/report-card.dto';

const FIXTURES: Record<string, ReportCardData> = {
  // Healthy user: letters across the grid, three new yesterday, varied bars.
  default: {
    user_external_id: '918888888001',
    letters_learnt: [
      'क', 'ख', 'ग', 'घ', 'च', 'छ', 'ज', 'झ',
      'ट', 'ठ', 'ड', 'ढ', 'त', 'थ', 'द', 'ध',
      'न', 'प', 'फ', 'ब',
    ],
    letters_learnt_yesterday: ['न', 'प', 'फ', 'ब'],
    daily_bars: [
      { date_iso: '2026-04-21', day_index: 2, active_ms: 0 },
      { date_iso: '2026-04-22', day_index: 3, active_ms: 200_000 },
      { date_iso: '2026-04-23', day_index: 4, active_ms: 350_000 },
      { date_iso: '2026-04-24', day_index: 5, active_ms: FIVE_MINUTES_MS },
      { date_iso: '2026-04-25', day_index: 6, active_ms: 60_000 },
      { date_iso: '2026-04-26', day_index: 0, active_ms: 720_000 },
      { date_iso: '2026-04-27', day_index: 1, active_ms: 480_000 },
    ],
  },
  // Edge: 0 letters learnt yesterday — no highlights.
  'no-yesterday': {
    user_external_id: '918888888002',
    letters_learnt: ['क', 'ख', 'ग'],
    letters_learnt_yesterday: [],
    daily_bars: [
      { date_iso: '2026-04-21', day_index: 2, active_ms: 100_000 },
      { date_iso: '2026-04-22', day_index: 3, active_ms: 200_000 },
      { date_iso: '2026-04-23', day_index: 4, active_ms: 250_000 },
      { date_iso: '2026-04-24', day_index: 5, active_ms: 350_000 },
      { date_iso: '2026-04-25', day_index: 6, active_ms: 400_000 },
      { date_iso: '2026-04-26', day_index: 0, active_ms: 500_000 },
      { date_iso: '2026-04-27', day_index: 1, active_ms: 600_000 },
    ],
  },
  // Edge: 0 activity for all 7 days.
  'zero-activity': {
    user_external_id: '918888888003',
    letters_learnt: ['क'],
    letters_learnt_yesterday: ['क'],
    daily_bars: Array.from({ length: 7 }, (_, i) => ({
      date_iso: `2026-04-${21 + i}`,
      day_index: (2 + i) % 7,
      active_ms: 0,
    })),
  },
  // Edge: brand new user (joined < 7 days, mostly empty bars + no letters yet).
  'new-user': {
    user_external_id: '918888888004',
    letters_learnt: [],
    letters_learnt_yesterday: [],
    daily_bars: [
      { date_iso: '2026-04-21', day_index: 2, active_ms: 0 },
      { date_iso: '2026-04-22', day_index: 3, active_ms: 0 },
      { date_iso: '2026-04-23', day_index: 4, active_ms: 0 },
      { date_iso: '2026-04-24', day_index: 5, active_ms: 0 },
      { date_iso: '2026-04-25', day_index: 6, active_ms: 0 },
      { date_iso: '2026-04-26', day_index: 0, active_ms: 80_000 },
      { date_iso: '2026-04-27', day_index: 1, active_ms: 200_000 },
    ],
  },
};

async function main() {
  const fixtureName = process.argv[2] ?? 'default';
  const data = FIXTURES[fixtureName];
  if (!data) {
    console.error(
      `Unknown fixture "${fixtureName}". Try: ${Object.keys(FIXTURES).join(', ')}`,
    );
    process.exit(1);
  }

  const svg = await buildReportCardSvg(data);
  const svgPath = `/tmp/report-card-${fixtureName}.svg`;
  fs.writeFileSync(svgPath, svg);

  const png = await sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
  const pngPath = `/tmp/report-card-${fixtureName}.png`;
  fs.writeFileSync(pngPath, png);

  console.log(`fixture: ${fixtureName}`);
  console.log(`  svg: ${svgPath}`);
  console.log(`  png: ${pngPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});