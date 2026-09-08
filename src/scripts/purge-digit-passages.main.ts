/* istanbul ignore file -- CLI bootstrap, exercised on Railway not in jest */
/**
 * CLI entry for the digit-passage purge (`npm run purge-digit-passages`).
 * Boots a Nest application context so the soft delete goes through the real
 * MediaMetaDataService.markRolledBack (recursive family flip + cache bust).
 * Preview is the default and strictly read-only; pass --execute to act.
 */
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { MediaMetaDataService } from '../media-meta-data/media-meta-data.service';
import { purgeDigitPassages } from './purge-digit-passages';

async function main(): Promise<void> {
  const mode: 'preview' | 'execute' = process.argv.includes('--execute')
    ? 'execute'
    : 'preview';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  try {
    const dataSource = app.get(DataSource);
    const mediaService = app.get(MediaMetaDataService);
    const report = await purgeDigitPassages(
      {
        query: (sql, params) => dataSource.query(sql, params),
        markRolledBack: (id) => mediaService.markRolledBack(id),
        log: (message) => console.log(message),
      },
      mode,
    );
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
