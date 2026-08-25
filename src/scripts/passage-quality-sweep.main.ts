/* istanbul ignore file -- CLI bootstrap, exercised on Railway not in jest */
/**
 * CLI entry for the passage-quality sweep (`npm run passage-quality-sweep`).
 * Boots a Nest application context and wires the real DataSource, LLM, and
 * MediaMetaDataService into the pure sweep in passage-quality-sweep.ts —
 * kept in a separate file so the sweep module (and its spec) never load
 * AppModule.
 */
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import { AppModule } from '../app.module';
import { MediaMetaDataService } from '../media-meta-data/media-meta-data.service';
import { SarvamLlmService } from '../interfaces/llm/sarvam/sarvam-llm.service';
import { runPassageQuality } from '../media-meta-data/passage-quality';
import { sweepPassageQuality } from './passage-quality-sweep';

async function main(): Promise<void> {
  const mode: 'report' | 'execute' = process.argv.includes('--execute')
    ? 'execute'
    : 'report';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  try {
    const dataSource = app.get(DataSource);
    const mediaService = app.get(MediaMetaDataService);
    const llm = app.get(SarvamLlmService);
    const generatedAt = new Date().toISOString();
    const report = await sweepPassageQuality(
      {
        query: (sql, params) => dataSource.query(sql, params),
        judgePassage: (text) => runPassageQuality(llm, text),
        recordPassageQuality: (id, quality) =>
          mediaService.recordPassageQuality(id, quality),
        markRolledBack: (id) => mediaService.markRolledBack(id),
        log: (message) => console.log(message),
      },
      mode,
      generatedAt,
    );
    const file = `passage-quality-sweep-${generatedAt.replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${file}`);
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
