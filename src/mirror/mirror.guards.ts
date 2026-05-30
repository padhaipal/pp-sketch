import { Client, type ClientConfig } from 'pg';
import {
  S3Client,
  ListObjectsV2Command,
  HeadBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

// TypeORM default; data-source.ts does not override migrationsTableName.
const MIGRATIONS_TABLE = 'migrations';

export interface DbIdent {
  url: string;
  label: 'prod' | 'staging';
}

// Node pg v8 treats sslmode=require as verify-full and rejects Railway's
// self-signed proxy chain. libpq (pg_dump/pg_restore) treats it correctly as
// "encrypt, don't verify CA". Strip sslmode from the URL before handing it
// to pg so pg-connection-string can't set verify-full from the URL, then
// pass ssl explicitly: encrypt without CA verify. Internal-network URLs
// without sslmode keep their existing no-SSL behavior.
export function pgClientConfig(url: string): ClientConfig {
  if (!/[?&]sslmode=/i.test(url)) {
    return { connectionString: url };
  }
  const stripped = url
    .replace(/([?&])sslmode=[^&]*&?/gi, '$1')
    .replace(/[?&]$/, '');
  return {
    connectionString: stripped,
    ssl: { rejectUnauthorized: false },
  };
}

async function withClient<T>(
  url: string,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(pgClientConfig(url));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function pgMajor(url: string): Promise<number> {
  return withClient(url, async (c) => {
    const r = await c.query<{ server_version_num: string }>(
      'SHOW server_version_num',
    );
    const num = Number(r.rows[0].server_version_num);
    return Math.floor(num / 10000);
  });
}

export async function assertPgVersionMatch(
  prod: DbIdent,
  staging: DbIdent,
): Promise<{ prod_major: number; staging_major: number }> {
  const [prodMajor, stagingMajor] = await Promise.all([
    pgMajor(prod.url),
    pgMajor(staging.url),
  ]);
  if (prodMajor !== stagingMajor) {
    throw new Error(
      `pg major mismatch: prod=${prodMajor} staging=${stagingMajor}`,
    );
  }
  return { prod_major: prodMajor, staging_major: stagingMajor };
}

// Lightweight presence check: confirm both envs are TypeORM-managed (have a
// `migrations` table with ≥1 row). Replaces the previous full-equality check,
// which was at the wrong layer — pg_restore IS the reconciliation step, and
// requiring equality before reconciliation was tautological. False positives
// on legitimate historical divergence (e.g. timestamp renames affecting only
// fresh envs) were blocking real mirror runs without protecting against any
// failure mode the deploy model (single main branch → both envs) can produce.
export async function assertMigrationsTablesPresent(
  prod: DbIdent,
  staging: DbIdent,
): Promise<{ prod_count: number; staging_count: number }> {
  const count = async (url: string): Promise<number> =>
    withClient(url, async (c) => {
      const r = await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${MIGRATIONS_TABLE}`,
      );
      return Number(r.rows[0].count);
    });
  const [prodCount, stagingCount] = await Promise.all([
    count(prod.url),
    count(staging.url),
  ]);
  if (prodCount < 1) {
    throw new Error(`prod migrations table is empty — not TypeORM-managed?`);
  }
  if (stagingCount < 1) {
    throw new Error(`staging migrations table is empty — not TypeORM-managed?`);
  }
  return { prod_count: prodCount, staging_count: stagingCount };
}

export async function assertProdReadOnly(prodUrl: string): Promise<void> {
  // Defense-in-depth: confirm prod creds cannot write. Attempt a no-op write;
  // expect a permission error. If it succeeds, the role is misconfigured and
  // the mirror MUST abort before pg_dump.
  await withClient(prodUrl, async (c) => {
    try {
      await c.query('CREATE TEMP TABLE mirror_ro_probe(x int) ON COMMIT DROP');
      // Temp tables succeed even for read-only roles. Try a real write.
      await c.query(
        `CREATE TABLE IF NOT EXISTS public._mirror_ro_probe(x int)`,
      );
      // If we got here, the role can write to public. Clean up + abort.
      await c.query(`DROP TABLE IF EXISTS public._mirror_ro_probe`);
      throw new Error(
        'prod role can write to public schema; refusing to mirror',
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('refusing to mirror')) throw err;
      // Expected: permission denied / must be owner / etc.
      return;
    }
  });
}

export interface BucketCreds {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createBucketClient(creds: BucketCreds): S3Client {
  return new S3Client({
    endpoint: creds.endpoint,
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

export async function assertProdBucketReadable(
  client: S3Client,
  bucket: string,
): Promise<void> {
  // List w/ MaxKeys=1 doubles as reachability + read-permission probe.
  await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
}

export async function assertStagingBucketWritable(
  client: S3Client,
  bucket: string,
): Promise<void> {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  const probeKey = `_mirror_probe_${Date.now()}`;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: probeKey,
      Body: Buffer.from('ok'),
      ContentLength: 2,
      ContentType: 'text/plain',
    }),
  );
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: probeKey }));
}
