// uuid is ESM-only; service imports it but markRolledBack does not use it.
jest.mock('uuid', () => ({ v4: jest.fn(() => 'unused-mock-uuid') }));

import { DataSource } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MediaMetaDataService } from './media-meta-data.service';
import { MediaMetaDataEntity } from './media-meta-data.entity';
import { UserEntity } from '../users/user.entity';

// Integration test: requires a real Postgres. Skipped unless TEST_DATABASE_URL is set.
// Run locally:
//   docker run -d --rm --name pp-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:18-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npx jest media-meta-data
const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('MediaMetaDataService.markRolledBack (integration)', () => {
  let dataSource: DataSource;
  let service: MediaMetaDataService;
  let mockBucketDelete: jest.Mock;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: TEST_DB_URL,
      synchronize: false,
      entities: [MediaMetaDataEntity, UserEntity],
    });
    await dataSource.initialize();

    await dataSource.query(`DROP TABLE IF EXISTS test_transcripts CASCADE`);
    await dataSource.query(`DROP TABLE IF EXISTS test_state_transitions CASCADE`);
    await dataSource.query(`DROP TABLE IF EXISTS media_metadata CASCADE`);
    await dataSource.query(`
      CREATE TABLE media_metadata (
        id uuid PRIMARY KEY,
        media_type text,
        source text,
        status text DEFAULT 'created',
        wa_media_url text,
        s3_key text,
        content_hash text,
        state_transition_id text,
        text text,
        media_details jsonb,
        generation_request_json jsonb,
        input_media_id uuid,
        user_id uuid,
        rolled_back boolean DEFAULT false,
        created_at timestamptz DEFAULT now()
      )`);
    await dataSource.query(`
      CREATE TABLE test_transcripts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        media_metadata_id uuid NOT NULL REFERENCES media_metadata(id),
        text text
      )`);
    await dataSource.query(`
      CREATE TABLE test_state_transitions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_message_id uuid NOT NULL REFERENCES media_metadata(id),
        payload text
      )`);
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(`DROP TABLE IF EXISTS test_transcripts CASCADE`);
      await dataSource.query(`DROP TABLE IF EXISTS test_state_transitions CASCADE`);
      await dataSource.query(`DROP TABLE IF EXISTS media_metadata CASCADE`);
      await dataSource.destroy();
    }
  });

  beforeEach(() => {
    mockBucketDelete = jest.fn().mockResolvedValue(undefined);
    // Bypass NestJS constructor — it calls createQueue() which requires Redis.
    // markRolledBack only uses dataSource, mediaRepo, mediaBucket, logger.
    service = Object.create(MediaMetaDataService.prototype) as MediaMetaDataService;
    (service as unknown as Record<string, unknown>).dataSource = dataSource;
    (service as unknown as Record<string, unknown>).mediaRepo = dataSource.getRepository(MediaMetaDataEntity);
    (service as unknown as Record<string, unknown>).mediaBucket = { delete: mockBucketDelete };
    (service as unknown as Record<string, unknown>).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  });

  afterEach(async () => {
    await dataSource.query(`TRUNCATE test_transcripts, test_state_transitions, media_metadata CASCADE`);
  });

  it('marks rolled_back=true, deletes FK-referencing rows, and best-effort-deletes from S3', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    await dataSource.query(
      `INSERT INTO media_metadata (id, media_type, source, s3_key) VALUES ($1, 'audio', 'whatsapp', 'some/s3/key')`,
      [id],
    );
    await dataSource.query(
      `INSERT INTO test_transcripts (media_metadata_id, text) VALUES ($1, 't1'), ($1, 't2')`,
      [id],
    );
    await dataSource.query(
      `INSERT INTO test_state_transitions (user_message_id, payload) VALUES ($1, 's1')`,
      [id],
    );

    await service.markRolledBack(id);

    const [{ rolled_back }] = await dataSource.query(
      `SELECT rolled_back FROM media_metadata WHERE id = $1`,
      [id],
    );
    expect(rolled_back).toBe(true);

    const [{ c: transcriptCount }] = await dataSource.query(
      `SELECT count(*)::int AS c FROM test_transcripts WHERE media_metadata_id = $1`,
      [id],
    );
    expect(transcriptCount).toBe(0);

    const [{ c: stateCount }] = await dataSource.query(
      `SELECT count(*)::int AS c FROM test_state_transitions WHERE user_message_id = $1`,
      [id],
    );
    expect(stateCount).toBe(0);

    expect(mockBucketDelete).toHaveBeenCalledWith('some/s3/key');
  });

  // Regression: the original implementation used a `DO $$ ... $$` block with $1,
  // which Postgres rejects with "bind message supplies 1 parameters, but prepared
  // statement requires 0". Anonymous DO blocks do not accept bind parameters.
  it('does NOT throw a parameter-bind error when invoked with a real id', async () => {
    const id = '22222222-2222-2222-2222-222222222222';
    await dataSource.query(
      `INSERT INTO media_metadata (id, media_type, source) VALUES ($1, 'audio', 'whatsapp')`,
      [id],
    );
    await dataSource.query(
      `INSERT INTO test_transcripts (media_metadata_id, text) VALUES ($1, 'x')`,
      [id],
    );

    await expect(service.markRolledBack(id)).resolves.toBeUndefined();
  });

  it('throws NotFoundException when the id does not exist and rolls back the transaction', async () => {
    const ghostId = '99999999-9999-9999-9999-999999999999';
    const otherId = '33333333-3333-3333-3333-333333333333';

    await dataSource.query(
      `INSERT INTO media_metadata (id, media_type, source) VALUES ($1, 'audio', 'whatsapp')`,
      [otherId],
    );
    await dataSource.query(
      `INSERT INTO test_transcripts (media_metadata_id, text) VALUES ($1, 'untouched')`,
      [otherId],
    );

    await expect(service.markRolledBack(ghostId)).rejects.toThrow(NotFoundException);

    // Other rows must be untouched.
    const [{ c }] = await dataSource.query(
      `SELECT count(*)::int AS c FROM test_transcripts WHERE media_metadata_id = $1`,
      [otherId],
    );
    expect(c).toBe(1);
  });

  it('throws BadRequestException for empty id', async () => {
    await expect(service.markRolledBack('')).rejects.toThrow(BadRequestException);
  });

  it('still resolves when S3 cleanup fails (best-effort)', async () => {
    const id = '44444444-4444-4444-4444-444444444444';
    await dataSource.query(
      `INSERT INTO media_metadata (id, media_type, source, s3_key) VALUES ($1, 'audio', 'whatsapp', 'k')`,
      [id],
    );
    mockBucketDelete.mockRejectedValueOnce(new Error('S3 down'));

    await expect(service.markRolledBack(id)).resolves.toBeUndefined();

    const [{ rolled_back }] = await dataSource.query(
      `SELECT rolled_back FROM media_metadata WHERE id = $1`,
      [id],
    );
    expect(rolled_back).toBe(true);
  });
});