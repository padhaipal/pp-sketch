/* istanbul ignore file -- CLI bootstrap, exercised on Railway not in jest */
/**
 * CLI entry: node dist/scripts/backfill-usage.main.js [--from YYYY-MM-DD]
 *   [--to YYYY-MM-DD] [--dry-run]
 * Backfills usage (active minutes) for referred students and their schools'
 * ancestor rows for every computed_for date in [from, to] (default: the
 * first WhatsApp voice note + 1 … today IST). See backfill-usage.prompt.md.
 */
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { GeoEntityService } from '../geo-entities/geo-entity.service';
import { TestResultsService } from '../literacy/score/test-results.service';
import { istDateIso } from '../notifier/report-card/report-card.utils';
import { backfillUsage } from './backfill-usage';

const DEFAULT_FROM = '2026-04-14';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const from = arg('from') ?? DEFAULT_FROM;
  const to = arg('to') ?? istDateIso(new Date());
  const dryRun = process.argv.includes('--dry-run');
  for (const [k, v] of Object.entries({ from, to })) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v))
      throw new Error(`--${k} must be YYYY-MM-DD, got ${v}`);
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  try {
    const dataSource = app.get(DataSource);
    const results = app.get(TestResultsService);
    const geo = app.get(GeoEntityService);
    const summary = await backfillUsage(
      {
        log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
        query: (sql, params) => dataSource.query(sql, params),
        ancestors: (id) => geo.ancestors(id),
        upsertStudentUsage: (rows, d, at) =>
          results.upsertStudentUsage(rows, d, at),
        upsertGeoUsage: (entries, d, at) =>
          results.upsertGeoUsage(entries, d, at),
      },
      { from, to, dryRun },
    );
    console.log(JSON.stringify({ ...summary, from, to, dryRun }));
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
