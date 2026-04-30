// Integration tests for ScoreService.getLetterBins.
// Requires Postgres. Skipped unless TEST_DATABASE_URL is set.
//   docker run -d --rm --name pp-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:18-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npx jest score.service

import { DataSource } from 'typeorm';
import { ScoreService } from './score.service';
import { LetterBinsResult } from './score.dto';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('ScoreService.getLetterBins (integration)', () => {
  let dataSource: DataSource;
  let service: ScoreService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: TEST_DB_URL,
      synchronize: false,
      entities: [],
    });
    await dataSource.initialize();

    await dataSource.query(`DROP TABLE IF EXISTS scores CASCADE`);
    await dataSource.query(`DROP TABLE IF EXISTS letters CASCADE`);
    await dataSource.query(`DROP TABLE IF EXISTS users CASCADE`);
    await dataSource.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        external_id text UNIQUE NOT NULL,
        created_at timestamptz DEFAULT now()
      )`);
    await dataSource.query(`
      CREATE TABLE letters (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        grapheme text UNIQUE NOT NULL,
        created_at timestamptz DEFAULT now()
      )`);
    await dataSource.query(`
      CREATE TABLE scores (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        letter_id uuid NOT NULL,
        user_message_id uuid,
        score double precision NOT NULL,
        created_at timestamptz DEFAULT now()
      )`);
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(`DROP TABLE IF EXISTS scores CASCADE`);
      await dataSource.query(`DROP TABLE IF EXISTS letters CASCADE`);
      await dataSource.query(`DROP TABLE IF EXISTS users CASCADE`);
      await dataSource.destroy();
    }
  });

  beforeEach(() => {
    service = new ScoreService(dataSource);
  });

  afterEach(async () => {
    await dataSource.query(
      `TRUNCATE scores, letters, users RESTART IDENTITY CASCADE`,
    );
  });

  async function makeUser(externalId: string): Promise<string> {
    const [{ id }] = await dataSource.query(
      `INSERT INTO users (external_id) VALUES ($1) RETURNING id`,
      [externalId],
    );
    return id;
  }

  async function makeLetter(grapheme: string): Promise<string> {
    const [{ id }] = await dataSource.query(
      `INSERT INTO letters (grapheme) VALUES ($1) RETURNING id`,
      [grapheme],
    );
    return id;
  }

  async function seed(
    userId: string,
    letterId: string,
    score: number,
    isoCreatedAt = '2026-01-01T00:00:00Z',
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO scores (user_id, letter_id, user_message_id, score, created_at)
       VALUES ($1, $2, NULL, $3, $4)`,
      [userId, letterId, score, isoCreatedAt],
    );
  }

  async function practice(
    userId: string,
    letterId: string,
    score: number,
    isoCreatedAt: string,
  ): Promise<void> {
    // Use a unique synthetic message id — the bucketing logic only checks
    // user_message_id IS NULL to identify the seed row, so any non-null will do.
    await dataSource.query(
      `INSERT INTO scores (user_id, letter_id, user_message_id, score, created_at)
       VALUES ($1, $2, gen_random_uuid(), $3, $4)`,
      [userId, letterId, score, isoCreatedAt],
    );
  }

  it('bin 1 (untouched): letter never seeded → grapheme included', async () => {
    const u = await makeUser('918888887001');
    await makeLetter('क'); // exists in letters table, no scores for u

    const res = (await service.getLetterBins(u)) as LetterBinsResult;
    expect(res.bins.untouched).toContain('क');
    expect(res.bins.regressed).not.toContain('क');
    expect(res.bins.learnt).not.toContain('क');
    expect(res.bins.improved).not.toContain('क');
  });

  it('bin 1: letter seeded but never practiced → untouched', async () => {
    const u = await makeUser('918888887002');
    const k = await makeLetter('क');
    await seed(u, k, 0);

    const res = (await service.getLetterBins(u)) as LetterBinsResult;
    expect(res.bins.untouched).toContain('क');
  });

  it('bin 1: letter has scores but no seed row → still untouched', async () => {
    const u = await makeUser('918888887003');
    const k = await makeLetter('क');
    await practice(u, k, 2, '2026-01-02T00:00:00Z');
    await practice(u, k, 3, '2026-01-03T00:00:00Z');

    const res = (await service.getLetterBins(u)) as LetterBinsResult;
    expect(res.bins.untouched).toContain('क');
  });

  it('bin 2 (regressed): final < seed', async () => {
    const u = await makeUser('918888887004');
    const k = await makeLetter('क');
    await seed(u, k, 0);
    await practice(u, k, -3, '2026-01-02T00:00:00Z');

    const res = (await service.getLetterBins(u)) as LetterBinsResult;
    expect(res.bins.regressed).toContain('क');
    expect(res.bins.untouched).not.toContain('क');
  });

  it('bin 2: final == seed (back to neutral after a dip) is regressed', async () => {
    const u = await makeUser('918888887005');
    const k = await makeLetter('क');
    await seed(u, k, 0);
    await practice(u, k, -3, '2026-01-02T00:00:00Z');
    await practice(u, k, 0, '2026-01-03T00:00:00Z');

    const res = (await service.getLetterBins(u)) as LetterBinsResult;
    expect(res.bins.regressed).toContain('क');
    expect(res.bins.learnt).not.toContain('क');
  });

  it('bin 3 (learnt): final > seed AND >= 4 rows AND min <= seed - 4', async () => {
    const u = await makeUser('918888887006');
    const k = await makeLetter('क');
    await seed(u, k, 0);
    await practice(u, k, 2, '2026-01-02T00:00:00Z');
    await practice(u, k, -4, '2026-01-03T00:00:00Z'); // dip ≥ 4 below seed
    await practice(u, k, 3, '2026-01-04T00:00:00Z'); // final > seed

    const res = (await service.getLetterBins(u)) as LetterBinsResult;
    expect(res.bins.learnt).toContain('क');
    expect(res.bins.improved).not.toContain('क');
  });

  it('bin 4 (improved): final > seed but no dip ≥ 4 below seed', async () => {
    const u = await makeUser('918888887007');
    const k = await makeLetter('क');
    await seed(u, k, 0);
    await practice(u, k, 2, '2026-01-02T00:00:00Z');
    await practice(u, k, 3, '2026-01-03T00:00:00Z');
    await practice(u, k, 5, '2026-01-04T00:00:00Z');

    const res = (await service.getLetterBins(u)) as LetterBinsResult;
    expect(res.bins.improved).toContain('क');
    expect(res.bins.learnt).not.toContain('क');
  });

  it('bin 4: final > seed with dip but fewer than 4 score rows → improved (not learnt)', async () => {
    const u = await makeUser('918888887008');
    const k = await makeLetter('क');
    await seed(u, k, 0);
    await practice(u, k, -4, '2026-01-02T00:00:00Z'); // dip
    await practice(u, k, 5, '2026-01-03T00:00:00Z'); // recover above

    // n_scores = 3 → fails the >=4 minimum → bin 4
    const res = (await service.getLetterBins(u)) as LetterBinsResult;
    expect(res.bins.improved).toContain('क');
    expect(res.bins.learnt).not.toContain('क');
  });

  it('bin 3 boundary: min == seed - 4 exactly counts as a qualifying dip (≤)', async () => {
    const u = await makeUser('918888887009');
    const k = await makeLetter('क');
    await seed(u, k, 0);
    await practice(u, k, 1, '2026-01-02T00:00:00Z');
    await practice(u, k, -4, '2026-01-03T00:00:00Z'); // exactly seed - 4
    await practice(u, k, 5, '2026-01-04T00:00:00Z');

    const res = (await service.getLetterBins(u)) as LetterBinsResult;
    expect(res.bins.learnt).toContain('क');
  });

  it('bin 4 boundary: min == seed - 3.99 (just above threshold) is improved', async () => {
    const u = await makeUser('918888887010');
    const k = await makeLetter('क');
    await seed(u, k, 0);
    await practice(u, k, 1, '2026-01-02T00:00:00Z');
    await practice(u, k, -3.99, '2026-01-03T00:00:00Z'); // doesn't dip far enough
    await practice(u, k, 5, '2026-01-04T00:00:00Z');

    const res = (await service.getLetterBins(u)) as LetterBinsResult;
    expect(res.bins.improved).toContain('क');
    expect(res.bins.learnt).not.toContain('क');
  });

  it('bins are disjoint: every grapheme in the letters table appears in exactly one bin', async () => {
    const u = await makeUser('918888887011');
    const a = await makeLetter('क');
    const b = await makeLetter('ख');
    const c = await makeLetter('ग');
    const d = await makeLetter('घ');
    const e = await makeLetter('ङ'); // never seeded
    void e;

    // a: untouched (seed only)
    await seed(u, a, 0);
    // b: regressed
    await seed(u, b, 0);
    await practice(u, b, -3, '2026-01-02T00:00:00Z');
    // c: learnt
    await seed(u, c, 0);
    await practice(u, c, 2, '2026-01-02T00:00:00Z');
    await practice(u, c, -4, '2026-01-03T00:00:00Z');
    await practice(u, c, 5, '2026-01-04T00:00:00Z');
    // d: improved
    await seed(u, d, 0);
    await practice(u, d, 2, '2026-01-02T00:00:00Z');
    // e: untouched (no scores at all)

    const res = (await service.getLetterBins(u)) as LetterBinsResult;
    const all = [
      ...res.bins.untouched,
      ...res.bins.regressed,
      ...res.bins.learnt,
      ...res.bins.improved,
    ];
    expect(all.sort()).toEqual(['क', 'ख', 'ग', 'घ', 'ङ'].sort());
    // No grapheme appears twice.
    expect(new Set(all).size).toBe(all.length);

    expect(res.bins.untouched).toEqual(expect.arrayContaining(['क', 'ङ']));
    expect(res.bins.regressed).toContain('ख');
    expect(res.bins.learnt).toContain('ग');
    expect(res.bins.improved).toContain('घ');
  });

  it('asOf cutoff: scores after asOf are excluded from bucketing', async () => {
    const u = await makeUser('918888887012');
    const k = await makeLetter('क');
    await seed(u, k, 0);
    await practice(u, k, 2, '2026-01-02T00:00:00Z');
    // After cutoff — must be ignored.
    await practice(u, k, -4, '2026-02-01T00:00:00Z');
    await practice(u, k, 5, '2026-02-02T00:00:00Z');

    const cutoff = new Date('2026-01-15T00:00:00Z');
    const res = (await service.getLetterBins(u, {
      asOf: cutoff,
    })) as LetterBinsResult;
    // At cutoff: seed=0, only one practice at 2 → final > seed,
    // n_scores = 2 (< 4) → bin 4 (improved), NOT learnt.
    expect(res.bins.improved).toContain('क');
    expect(res.bins.learnt).not.toContain('क');
  });

  it('returns array shape when given an array of users; preserves input order, dedupes', async () => {
    const a = await makeUser('918888887013');
    const b = await makeUser('918888887014');
    const k = await makeLetter('क');
    await seed(a, k, 0);
    await seed(b, k, 0);

    const res = (await service.getLetterBins([
      b,
      a,
      '918888887013', // dup of a, by phone
    ])) as LetterBinsResult[];
    expect(res.map((r) => r.userId)).toEqual([b, a]);
  });

  it('returns single shape when given a single string', async () => {
    const u = await makeUser('918888887015');
    const k = await makeLetter('क');
    await seed(u, k, 0);

    const res = await service.getLetterBins(u);
    // Single result has bins.untouched, etc.
    expect((res as LetterBinsResult).bins.untouched).toContain('क');
  });
});
