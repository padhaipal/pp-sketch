// Integration tests for UserActivityService.getActivityTime.
// Requires Postgres. Skipped unless TEST_DATABASE_URL is set.
//   docker run -d --rm --name pp-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:18-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npx jest user-activity

import { DataSource } from 'typeorm';
import { Repository } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { UserActivityService } from './user-activity.service';
import { UserEntity } from './user.entity';
import { MediaMetaDataEntity } from '../media-meta-data/media-meta-data.entity';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('UserActivityService.getActivityTime (integration)', () => {
  let dataSource: DataSource;
  let service: UserActivityService;
  let userRepo: Repository<UserEntity>;
  let mediaRepo: Repository<MediaMetaDataEntity>;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: TEST_DB_URL,
      synchronize: false,
      entities: [MediaMetaDataEntity, UserEntity],
    });
    await dataSource.initialize();

    await dataSource.query(`DROP TABLE IF EXISTS media_metadata CASCADE`);
    await dataSource.query(`DROP TABLE IF EXISTS users CASCADE`);
    await dataSource.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        external_id text UNIQUE NOT NULL,
        referrer_user_id uuid,
        name text,
        password_hash text,
        role text,
        created_at timestamptz DEFAULT now()
      )`);
    await dataSource.query(`
      CREATE TABLE media_metadata (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        media_type text NOT NULL,
        source text NOT NULL,
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
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(`DROP TABLE IF EXISTS media_metadata CASCADE`);
      await dataSource.query(`DROP TABLE IF EXISTS users CASCADE`);
      await dataSource.destroy();
    }
  });

  beforeEach(() => {
    userRepo = dataSource.getRepository(UserEntity);
    mediaRepo = dataSource.getRepository(MediaMetaDataEntity);
    service = new UserActivityService(userRepo, mediaRepo);
  });

  afterEach(async () => {
    await dataSource.query(
      `TRUNCATE media_metadata, users RESTART IDENTITY CASCADE`,
    );
  });

  async function makeUser(externalId: string): Promise<string> {
    const [{ id }] = await dataSource.query(
      `INSERT INTO users (external_id) VALUES ($1) RETURNING id`,
      [externalId],
    );
    return id;
  }

  async function insertVoice(
    userId: string,
    isoCreatedAt: string,
    extra: { source?: string; media_type?: string; rolled_back?: boolean } = {},
  ): Promise<void> {
    const source = extra.source ?? 'whatsapp';
    const media_type = extra.media_type ?? 'audio';
    const rolled_back = extra.rolled_back ?? false;
    await dataSource.query(
      `INSERT INTO media_metadata (media_type, source, status, user_id, rolled_back, created_at)
       VALUES ($1, $2, 'ready', $3, $4, $5)`,
      [media_type, source, userId, rolled_back, isoCreatedAt],
    );
  }

  it('sums gaps < 60 s between consecutive voice messages inside a window', async () => {
    const id = await makeUser('918888888001');
    // 5 messages: 0, 30s, 80s (gap=50s), 200s (gap=120s, excluded), 220s (gap=20s)
    await insertVoice(id, '2026-04-27T10:00:00Z');
    await insertVoice(id, '2026-04-27T10:00:30Z');
    await insertVoice(id, '2026-04-27T10:01:50Z');
    await insertVoice(id, '2026-04-27T10:05:10Z');
    await insertVoice(id, '2026-04-27T10:05:30Z');

    const res = await service.getActivityTime({
      users: [id],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });

    expect(res.results).toHaveLength(1);
    // Active = (30s gap) + (50s gap is ok, < 60s) wait recompute:
    //   m0=0,    m1=30s   gap=30s    -> +30s
    //   m1=30s,  m2=110s  gap=80s    -> excluded (>= 60s)
    //   m2=110s, m3=310s  gap=200s   -> excluded
    //   m3=310s, m4=330s  gap=20s    -> +20s
    // total = 50s = 50_000 ms
    expect(res.results[0].windows[0].active_ms).toBe(50_000);
  });

  it('returns 0 when fewer than 2 messages fall in the window', async () => {
    const id = await makeUser('918888888002');
    await insertVoice(id, '2026-04-27T10:00:00Z');

    const res = await service.getActivityTime({
      users: [id],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(res.results[0].windows[0].active_ms).toBe(0);
  });

  it('handles overlapping windows independently', async () => {
    const id = await makeUser('918888888003');
    await insertVoice(id, '2026-04-27T10:00:00Z');
    await insertVoice(id, '2026-04-27T10:00:20Z');
    await insertVoice(id, '2026-04-27T11:00:00Z');
    await insertVoice(id, '2026-04-27T11:00:30Z');

    const res = await service.getActivityTime({
      users: [id],
      windows: [
        { start: '2026-04-27T09:30:00Z', end: '2026-04-27T10:30:00Z' },
        { start: '2026-04-27T10:30:00Z', end: '2026-04-27T11:30:00Z' },
        { start: '2026-04-27T09:30:00Z', end: '2026-04-27T11:30:00Z' },
      ],
    });

    expect(res.results[0].windows[0].active_ms).toBe(20_000);
    expect(res.results[0].windows[1].active_ms).toBe(30_000);
    // The wide window must NOT bridge across the >60s gap between the two pairs.
    expect(res.results[0].windows[2].active_ms).toBe(50_000);
  });

  it('only counts messages strictly inside the window (boundary is inclusive)', async () => {
    const id = await makeUser('918888888004');
    // boundary at 10:00:00 — first message is exactly on the edge
    await insertVoice(id, '2026-04-27T10:00:00Z');
    await insertVoice(id, '2026-04-27T10:00:25Z');
    // outside upper boundary → excluded
    await insertVoice(id, '2026-04-27T11:00:01Z');
    await insertVoice(id, '2026-04-27T11:00:30Z');

    const res = await service.getActivityTime({
      users: [id],
      windows: [{ start: '2026-04-27T10:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(res.results[0].windows[0].active_ms).toBe(25_000);
  });

  it('does not bridge gaps that span outside the window (resets prev across exclusion)', async () => {
    const id = await makeUser('918888888005');
    // Two pairs separated by a long out-of-window gap. If implementation buggy,
    // it might count message-pair-across-window as active.
    await insertVoice(id, '2026-04-27T09:30:00Z');
    await insertVoice(id, '2026-04-27T09:30:10Z');
    // Out of window
    await insertVoice(id, '2026-04-27T10:30:00Z');
    // Back inside window
    await insertVoice(id, '2026-04-27T11:00:30Z');

    const res = await service.getActivityTime({
      users: [id],
      windows: [
        // includes 09:30 pair; ends at 09:45 (excludes the rest)
        { start: '2026-04-27T09:00:00Z', end: '2026-04-27T09:45:00Z' },
      ],
    });
    expect(res.results[0].windows[0].active_ms).toBe(10_000);
  });

  it('ignores rolled-back messages and non-audio sources', async () => {
    const id = await makeUser('918888888006');
    await insertVoice(id, '2026-04-27T10:00:00Z');
    await insertVoice(id, '2026-04-27T10:00:20Z', { rolled_back: true });
    await insertVoice(id, '2026-04-27T10:00:40Z', { media_type: 'video' });
    await insertVoice(id, '2026-04-27T10:01:00Z', { source: 'heygen' });
    await insertVoice(id, '2026-04-27T10:01:30Z');

    const res = await service.getActivityTime({
      users: [id],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    // Only the two real whatsapp/audio rows count (10:00:00 and 10:01:30) →
    // gap 90 s, > 60 s → 0.
    expect(res.results[0].windows[0].active_ms).toBe(0);
  });

  it('returns separate results per user, indexed by input order', async () => {
    const a = await makeUser('918888888007');
    const b = await makeUser('918888888008');
    await insertVoice(a, '2026-04-27T10:00:00Z');
    await insertVoice(a, '2026-04-27T10:00:15Z');
    await insertVoice(b, '2026-04-27T10:00:00Z');
    await insertVoice(b, '2026-04-27T10:00:45Z');

    const res = await service.getActivityTime({
      users: [b, a],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(res.results.map((r) => r.user_id)).toEqual([b, a]);
    expect(res.results[0].windows[0].active_ms).toBe(45_000);
    expect(res.results[1].windows[0].active_ms).toBe(15_000);
  });

  it('accepts mixed UUID + external_id inputs and dedupes by user', async () => {
    const id = await makeUser('918888888009');
    await insertVoice(id, '2026-04-27T10:00:00Z');
    await insertVoice(id, '2026-04-27T10:00:30Z');

    const res = await service.getActivityTime({
      users: [id, '918888888009'],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].external_id).toBe('918888888009');
    expect(res.results[0].windows[0].active_ms).toBe(30_000);
  });

  it('returns 0 active_ms for users with no voice messages at all', async () => {
    const id = await makeUser('918888888010');
    const res = await service.getActivityTime({
      users: [id],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(res.results[0].windows[0].active_ms).toBe(0);
  });

  it('rejects start > end', async () => {
    const id = await makeUser('918888888011');
    await expect(
      service.getActivityTime({
        users: [id],
        windows: [
          { start: '2026-04-27T11:00:00Z', end: '2026-04-27T10:00:00Z' },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns empty results when no users resolve', async () => {
    const res = await service.getActivityTime({
      users: ['nonexistent-phone-919999999999'],
      windows: [{ start: '2026-04-27T09:00:00Z', end: '2026-04-27T11:00:00Z' }],
    });
    expect(res.results).toHaveLength(0);
  });

  it('handles many overlapping windows in a single round trip', async () => {
    const id = await makeUser('918888888012');
    // Steady stream every 30 s for 10 minutes — every gap = 30 s.
    for (let i = 0; i < 21; i++) {
      const t = new Date(`2026-04-27T10:00:00Z`).getTime() + i * 30_000;
      await insertVoice(id, new Date(t).toISOString());
    }

    const windows = Array.from({ length: 10 }, (_, i) => ({
      start: `2026-04-27T10:${String(i).padStart(2, '0')}:00Z`,
      end: `2026-04-27T10:${String(i + 1).padStart(2, '0')}:00Z`,
    }));
    const res = await service.getActivityTime({ users: [id], windows });

    // Each 1-min window [xx:00, xx+1:00] inclusively contains 3 messages
    // (xx:00, xx:30, xx+1:00 — both boundaries are inclusive). That's two
    // 30 s gaps → 60 000 ms per window.
    for (const w of res.results[0].windows) {
      expect(w.active_ms).toBe(60_000);
    }
  });
});
