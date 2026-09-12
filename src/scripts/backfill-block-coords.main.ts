/* istanbul ignore file -- CLI bootstrap, exercised on Railway not in jest */
/**
 * CLI entry: node dist/scripts/backfill-block-coords.main.js
 * Writes each block's geometric-median coordinate from its located schools
 * (backfill-block-coords.ts). For databases seeded before the seed gained
 * this as its final step. Runbook: src/docs/seeding-geo-entities.md.
 */
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { GeoEntityService } from '../geo-entities/geo-entity.service';
import { backfillBlockCoords } from './backfill-block-coords';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  try {
    const dataSource = app.get(DataSource);
    const geo = app.get(GeoEntityService);
    let manager: {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
    } | null = null;
    const summary = await backfillBlockCoords({
      log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
      query: (sql, params) => dataSource.query(sql, params),
      transaction: (fn) =>
        dataSource.transaction(async (m) => {
          manager = m;
          try {
            return await fn();
          } finally {
            manager = null;
          }
        }),
      updateBlockCoordinates: (id, lat, lng) =>
        geo.updateBlockCoordinates(id, lat, lng, manager as never),
    });
    console.log(JSON.stringify(summary));
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
