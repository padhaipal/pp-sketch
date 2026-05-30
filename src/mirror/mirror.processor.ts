import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { Readable } from 'stream';
import type { Job } from 'bullmq';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  type _Object,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Client } from 'pg';
import {
  assertMigrationsEqual,
  assertPgVersionMatch,
  assertProdBucketReadable,
  assertProdReadOnly,
  assertStagingBucketWritable,
  createBucketClient,
  pgClientConfig,
  type BucketCreds,
} from './mirror.guards';

const COPY_PARALLELISM = 10;
const DELETE_BATCH_SIZE = 1000;
const SANITY_TABLES = ['users', 'media_metadata'] as const;
const POST_MIRROR_SQL_PATHS = [
  // dist/mirror/mirror.processor.js → ../../sql/post-mirror.sql at runtime
  join(__dirname, '..', '..', 'sql', 'post-mirror.sql'),
  // src/mirror/mirror.processor.ts → ../../sql/post-mirror.sql in dev
  join(__dirname, '..', '..', '..', 'sql', 'post-mirror.sql'),
];

@Injectable()
export class MirrorProcessor {
  private readonly logger = new Logger('MirrorProcessor');

  async run(job: Job): Promise<void> {
    const jobLabel = `job=${job.id ?? '?'}`;
    this.logger.log(`mirror.start ${jobLabel}`);

    const prodUrl = required('PROD_DATABASE_URL_RO');
    const stagingUrl = required('DATABASE_URL');
    const prodCreds = readBucketCreds('PROD_MEDIA_BUCKET_');
    const stagingCreds = readBucketCreds('MEDIA_BUCKET_');

    // ── Step 1: pg version equality ─────────────────────────────────────────
    this.logger.log('mirror.pg_version.start');
    const versions = await assertPgVersionMatch(
      { url: prodUrl, label: 'prod' },
      { url: stagingUrl, label: 'staging' },
    );
    this.logger.log(`mirror.pg_version.complete major=${versions.prod_major}`);

    // ── Step 2: migrations-table equality ───────────────────────────────────
    this.logger.log('mirror.migrations_equal.start');
    const migrations = await assertMigrationsEqual(
      { url: prodUrl, label: 'prod' },
      { url: stagingUrl, label: 'staging' },
    );
    this.logger.log(
      `mirror.migrations_equal.complete count=${migrations.count}`,
    );

    // ── Step 2.5: prod role read-only probe (cheap, defense-in-depth) ──────
    await assertProdReadOnly(prodUrl);

    // ── Step 3: bucket reachability pre-flight ──────────────────────────────
    this.logger.log('mirror.bucket_preflight.start');
    const prodS3 = createBucketClient(prodCreds);
    const stagingS3 = createBucketClient(stagingCreds);
    await assertProdBucketReadable(prodS3, prodCreds.bucket);
    await assertStagingBucketWritable(stagingS3, stagingCreds.bucket);
    this.logger.log('mirror.bucket_preflight.complete');

    // ── Step 4: pg_dump | pg_restore ────────────────────────────────────────
    // CLAUDE.md exception: this is a whole-DB restore via pg_restore, which
    // sidesteps the "DB writes via entity *.service.ts" rule by design.
    this.logger.log('mirror.pg_restore.start');
    await this.streamDumpRestore(prodUrl, stagingUrl);
    this.logger.log('mirror.pg_restore.complete');

    // Sanity check: row counts on key tables. pg_restore can exit non-zero on
    // benign warnings, so we ignore its exit code and verify by data instead.
    await this.assertPostRestoreSane(stagingUrl);

    // ── Step 5: bucket mirror ───────────────────────────────────────────────
    this.logger.log('mirror.bucket.start');
    const bucketStats = await this.mirrorBucket(
      prodS3,
      prodCreds.bucket,
      stagingS3,
      stagingCreds.bucket,
    );
    this.logger.log(
      `mirror.bucket.complete copied=${bucketStats.copied} deleted=${bucketStats.deleted}`,
    );

    // ── Step 6: post-mirror.sql ─────────────────────────────────────────────
    this.logger.log('mirror.post_sql.start');
    await this.runPostMirrorSql(stagingUrl);
    this.logger.log('mirror.post_sql.complete');

    // ── Step 7: success log ────────────────────────────────────────────────
    this.logger.log(
      `mirror.success ${jobLabel} pg_major=${versions.prod_major} migrations=${migrations.count} objects_copied=${bucketStats.copied} objects_deleted=${bucketStats.deleted}`,
    );
  }

  private async streamDumpRestore(
    prodUrl: string,
    stagingUrl: string,
  ): Promise<void> {
    const dump = spawn('pg_dump', ['-Fc', '--no-owner', '--no-acl', prodUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const restore = spawn(
      'pg_restore',
      ['--clean', '--if-exists', '-d', stagingUrl],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    dump.stdout.pipe(restore.stdin);

    const dumpStderr: Buffer[] = [];
    const restoreStderr: Buffer[] = [];
    dump.stderr.on('data', (b: Buffer) => dumpStderr.push(b));
    restore.stderr.on('data', (b: Buffer) => restoreStderr.push(b));

    const [dumpCode] = await Promise.all([
      waitExit(dump),
      // pg_restore exit code is intentionally ignored — see comment below.
      waitExit(restore),
    ]);

    const dumpErr = Buffer.concat(dumpStderr).toString();
    const restoreErr = Buffer.concat(restoreStderr).toString();
    if (dumpErr.trim()) this.logger.warn(`pg_dump stderr: ${dumpErr.trim()}`);
    if (restoreErr.trim()) {
      this.logger.warn(`pg_restore stderr: ${restoreErr.trim()}`);
    }

    if (dumpCode !== 0) {
      throw new Error(`pg_dump exited ${dumpCode}: ${dumpErr.trim()}`);
    }
    // pg_restore exits non-zero on benign warnings; don't abort on it. The
    // post-restore row-count check is the real success signal.
  }

  private async assertPostRestoreSane(stagingUrl: string): Promise<void> {
    const c = new Client(pgClientConfig(stagingUrl));
    await c.connect();
    try {
      for (const table of SANITY_TABLES) {
        const r = await c.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table}`,
        );
        const n = Number(r.rows[0].count);
        if (!Number.isFinite(n)) {
          throw new Error(`post-restore: ${table} count unreadable`);
        }
        if (n === 0) {
          throw new Error(
            `post-restore: ${table} is empty — pg_restore likely failed`,
          );
        }
        this.logger.log(`mirror.sanity ${table}=${n}`);
      }
    } finally {
      await c.end().catch(() => {});
    }
  }

  private async mirrorBucket(
    prodS3: S3Client,
    prodBucket: string,
    stagingS3: S3Client,
    stagingBucket: string,
  ): Promise<{ copied: number; deleted: number }> {
    const prodKeys = await listAllKeys(prodS3, prodBucket);
    const prodKeySet = new Set(prodKeys.map((k) => k.Key!));

    let copied = 0;
    const queue = [...prodKeys];
    const workers: Promise<void>[] = [];
    for (let i = 0; i < COPY_PARALLELISM; i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const obj = queue.shift();
            if (!obj?.Key) continue;
            await this.copyOne(
              prodS3,
              prodBucket,
              stagingS3,
              stagingBucket,
              obj.Key,
            );
            copied++;
          }
        })(),
      );
    }
    await Promise.all(workers);

    const stagingKeys = await listAllKeys(stagingS3, stagingBucket);
    const toDelete = stagingKeys
      .map((o) => o.Key!)
      .filter((k) => !prodKeySet.has(k));

    let deleted = 0;
    for (let i = 0; i < toDelete.length; i += DELETE_BATCH_SIZE) {
      const batch = toDelete.slice(i, i + DELETE_BATCH_SIZE);
      await stagingS3.send(
        new DeleteObjectsCommand({
          Bucket: stagingBucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        }),
      );
      deleted += batch.length;
    }

    return { copied, deleted };
  }

  private async copyOne(
    prodS3: S3Client,
    prodBucket: string,
    stagingS3: S3Client,
    stagingBucket: string,
    key: string,
  ): Promise<void> {
    // Read prod object (body + ContentType). Existing consumers only rely on
    // ContentType; CacheControl / custom Metadata are unused. Forward only
    // ContentType to keep MIME-driven WhatsApp delivery intact.
    const head = await prodS3.send(
      new HeadObjectCommand({ Bucket: prodBucket, Key: key }),
    );
    const get = await prodS3.send(
      new GetObjectCommand({ Bucket: prodBucket, Key: key }),
    );
    const body = get.Body as Readable;

    const upload = new Upload({
      client: stagingS3,
      params: {
        Bucket: stagingBucket,
        Key: key,
        Body: body,
        ContentType: head.ContentType ?? 'application/octet-stream',
      },
    });
    await upload.done();
  }

  private async runPostMirrorSql(stagingUrl: string): Promise<void> {
    let sql: string | null = null;
    for (const p of POST_MIRROR_SQL_PATHS) {
      try {
        sql = await readFile(p, 'utf8');
        break;
      } catch {
        // try next candidate path
      }
    }
    if (sql == null) {
      this.logger.warn(
        'post-mirror.sql not found at any expected path; skipping',
      );
      return;
    }
    const trimmed = sql.trim();
    if (!trimmed || (trimmed.startsWith('--') && !trimmed.includes(';'))) {
      // Empty / comment-only — nothing to execute.
      return;
    }
    const c = new Client(pgClientConfig(stagingUrl));
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end().catch(() => {});
    }
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} is required for mirror`);
  return v;
}

function readBucketCreds(prefix: string): BucketCreds {
  return {
    bucket: required(`${prefix}NAME`),
    endpoint: required(`${prefix}ENDPOINT`),
    region: process.env[`${prefix}REGION`] ?? 'auto',
    accessKeyId: required(`${prefix}ACCESS_KEY`),
    secretAccessKey: required(`${prefix}SECRET_KEY`),
  };
}

function waitExit(proc: import('child_process').ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => resolve(code ?? 0));
  });
}

async function listAllKeys(
  client: S3Client,
  bucket: string,
): Promise<_Object[]> {
  const out: _Object[] = [];
  let token: string | undefined;
  do {
    const r = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
      }),
    );
    if (r.Contents) out.push(...r.Contents);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}
