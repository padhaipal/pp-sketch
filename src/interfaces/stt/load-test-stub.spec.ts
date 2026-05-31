jest.mock('uuid', () => ({ v4: jest.fn(() => 'gen-uuid') }));

import type { Repository } from 'typeorm';
import {
  isLoadTestUser,
  loadTestDelay,
  saveStubTranscript,
} from './load-test-stub';
import type { MediaMetaDataEntity } from '../../media-meta-data/media-meta-data.entity';
import type { MediaMetaData } from '../../media-meta-data/media-meta-data.dto';

type RepoMock = { create: jest.Mock; save: jest.Mock };

function makeRepo(): RepoMock {
  return {
    create: jest.fn((row) => ({ ...row })),
    save: jest
      .fn()
      .mockImplementation(async (e) => ({ ...e, created_at: new Date() })),
  };
}

const parentMedia: MediaMetaData = {
  id: 'parent-1',
  user_id: 'u1',
  media_type: 'audio',
  source: 'whatsapp',
  status: 'ready',
  rolled_back: false,
  created_at: new Date(),
  media_details: { mime_type: 'audio/ogg' },
} as MediaMetaData;

describe('isLoadTestUser', () => {
  const PREFIX = '911000';

  afterEach(() => {
    delete process.env.LOAD_TEST_PHONE_PREFIX;
  });

  it('returns false when LOAD_TEST_PHONE_PREFIX is unset', () => {
    expect(isLoadTestUser('911000123456')).toBe(false);
  });

  it('returns false when LOAD_TEST_PHONE_PREFIX is the empty string', () => {
    process.env.LOAD_TEST_PHONE_PREFIX = '';
    expect(isLoadTestUser('911000123456')).toBe(false);
  });

  it('returns false when userExternalId is undefined', () => {
    process.env.LOAD_TEST_PHONE_PREFIX = PREFIX;
    expect(isLoadTestUser(undefined)).toBe(false);
  });

  it('returns false when userExternalId does not start with the prefix', () => {
    process.env.LOAD_TEST_PHONE_PREFIX = PREFIX;
    expect(isLoadTestUser('919999990001')).toBe(false);
  });

  it('returns true when userExternalId starts with the prefix', () => {
    process.env.LOAD_TEST_PHONE_PREFIX = PREFIX;
    expect(isLoadTestUser('911000123456')).toBe(true);
  });

  it('returns true when userExternalId equals the prefix exactly', () => {
    process.env.LOAD_TEST_PHONE_PREFIX = PREFIX;
    expect(isLoadTestUser(PREFIX)).toBe(true);
  });

  it('returns false when prefix appears in the middle, not the start', () => {
    process.env.LOAD_TEST_PHONE_PREFIX = PREFIX;
    expect(isLoadTestUser(`99${PREFIX}99`)).toBe(false);
  });
});

describe('loadTestDelay', () => {
  it('resolves with a delay of at least 200ms', async () => {
    const start = Date.now();
    await loadTestDelay();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    // Bounded so the test doesn't hang if the jitter range changes.
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe('saveStubTranscript', () => {
  it('creates+saves a text media row with the stub transcript and load_test_stub flag', async () => {
    const repo = makeRepo();
    const out = await saveStubTranscript(
      repo as unknown as Repository<MediaMetaDataEntity>,
      parentMedia,
      'sarvam',
    );

    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledTimes(1);
    const created = repo.create.mock.calls[0][0];
    expect(created).toMatchObject({
      id: 'gen-uuid',
      media_type: 'text',
      source: 'sarvam',
      status: 'ready',
      text: '<load-test stub transcript>',
      input_media_id: parentMedia.id,
      user_id: parentMedia.user_id,
      rolled_back: false,
      media_details: { load_test_stub: true },
    });
    expect(out.text).toBe('<load-test stub transcript>');
  });

  it('preserves the source field across all three STT providers', async () => {
    for (const source of ['sarvam', 'azure', 'reverie'] as const) {
      const repo = makeRepo();
      await saveStubTranscript(
        repo as unknown as Repository<MediaMetaDataEntity>,
        parentMedia,
        source,
      );
      expect(repo.create.mock.calls[0][0].source).toBe(source);
    }
  });

  it('throws on an unrecognized source (assertValidMediaSource gates)', async () => {
    const repo = makeRepo();
    await expect(
      saveStubTranscript(
        repo as unknown as Repository<MediaMetaDataEntity>,
        parentMedia,
        'unknown-source' as never,
      ),
    ).rejects.toThrow();
  });
});
