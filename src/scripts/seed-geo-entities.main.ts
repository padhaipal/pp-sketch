/* istanbul ignore file -- CLI bootstrap, exercised on Railway not in jest */
/**
 * CLI entry: node dist/scripts/seed-geo-entities.main.js --pulled-at <ISO>
 * [--dry-run] [--schools-url …] [--manifest …] [--status-map …].
 * Boots a Nest application context for the DataSource + GeoEntityService and
 * hands real I/O to the pure orchestrator in seed-geo-entities.ts. Runbook:
 * src/docs/seeding-geo-entities.md.
 */
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { createGunzip } from 'zlib';
import { AppModule } from '../app.module';
import { GeoEntityService } from '../geo-entities/geo-entity.service';
import { parseArgs, runSeed } from './seed-geo-entities';

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${url}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as never),
    fs.createWriteStream(dest),
  );
}

async function readText(pathOrUrl: string): Promise<string> {
  if (/^https?:\/\//.test(pathOrUrl)) {
    const res = await fetch(pathOrUrl);
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${pathOrUrl}`);
    return res.text();
  }
  return fs.readFileSync(pathOrUrl, 'utf-8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env, (p) =>
    fs.readFileSync(p, 'utf-8'),
  );
  const log = (message: string) =>
    console.log(`[${new Date().toISOString()}] ${message}`);

  // Download once, stream twice: the 156 MB gzip is spooled to disk and
  // decompressed on each pass — the 962 MB expansion is never buffered.
  const spool = path.join(os.tmpdir(), 'schools_india_with_coords.csv.gz');
  if (/^https?:\/\//.test(args.schoolsUrl)) {
    log(`downloading ${args.schoolsUrl} → ${spool}`);
    await download(args.schoolsUrl, spool);
  } else {
    fs.copyFileSync(args.schoolsUrl, spool);
  }
  log(`spooled ${(fs.statSync(spool).size / 1e6).toFixed(1)} MB`);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  try {
    const dataSource = app.get(DataSource);
    const geo = app.get(GeoEntityService);
    let manager: {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
    } | null = null;

    await runSeed(
      {
        log,
        openRows: () => fs.createReadStream(spool).pipe(createGunzip()),
        readManifest: () => readText(args.manifest),
        // Inside a transaction the upsert must use that transaction's
        // manager; the orchestrator opens levels via `transaction` below.
        upsertBatch: (rows) => geo.upsertBatch(rows, manager as never),
        transaction: async (fn) =>
          dataSource.transaction(async (m) => {
            manager = m;
            try {
              return await fn();
            } finally {
              manager = null;
            }
          }),
        codeMap: (type) => geo.codeMap(type),
        linkMergedSchools: () => geo.linkMergedSchools(),
        mergeEdges: () => geo.mergeEdges(),
        clearMergedInto: (ids) => geo.clearMergedInto(ids),
        updateBlockCoordinates: (id, lat, lng) =>
          geo.updateBlockCoordinates(id, lat, lng, manager as never),
        query: (sql, params) => dataSource.query(sql, params),
      },
      args,
    );
    log('done');
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
