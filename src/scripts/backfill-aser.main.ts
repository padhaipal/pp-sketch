/* istanbul ignore file -- CLI bootstrap, exercised on Railway not in jest */
/**
 * CLI entry: node dist/scripts/backfill-aser.main.js [--from YYYY-MM-DD]
 *   [--to YYYY-MM-DD] [--dry-run]
 * Backfills the ASER proxy (aser_grade_*) on area rows and existing student
 * rows for every computed_for date in [from, to] (default: the night after
 * the first finished ASER run … today IST). Safe to run again. See
 * backfill-aser.prompt.md.
 */
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { GeoEntityService } from '../geo-entities/geo-entity.service';
import { computeAserTestScores } from '../literacy/aser/aser';
import { TestResultsService } from '../literacy/score/test-results.service';
import { istDateIso } from '../notifier/report-card/report-card.utils';
import { backfillAser } from './backfill-aser';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const from = arg('from');
  const to = arg('to') ?? istDateIso(new Date());
  const dryRun = process.argv.includes('--dry-run');
  for (const [k, v] of Object.entries({ from, to })) {
    if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v))
      throw new Error(`--${k} must be YYYY-MM-DD, got ${v}`);
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  try {
    const dataSource = app.get(DataSource);
    const results = app.get(TestResultsService);
    const geo = app.get(GeoEntityService);
    const query = (sql: string, params?: unknown[]) =>
      dataSource.query(sql, params);
    const summary = await backfillAser(
      {
        log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
        query,
        aserTests: (ids) => computeAserTestScores(query, ids),
        ancestors: (id) => geo.ancestors(id),
        updateStudentAserGrade: (rows, d) =>
          results.updateStudentAserGrade(rows, d),
        upsertGeoAserGrade: (entries, d, at) =>
          results.upsertGeoUsage(entries, d, at, 'aser_grade'),
      },
      { from, to, dryRun },
    );
    console.log(JSON.stringify({ ...summary, to, dryRun }));
  } finally {
    await app.close();
  }
  // queues.ts opens a module-level ioredis client on import that nothing
  // closes, so the event loop never drains on its own. Every write above is
  // awaited before the summary prints; exiting here loses nothing.
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
