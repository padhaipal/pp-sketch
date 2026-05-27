// Unit tests for MediaMetaDataService. All collaborators (DB, cache,
// wabot, STT, S3, queues) are mocked.

jest.mock('uuid', () => ({ v4: jest.fn(() => 'gen-uuid') }));

const mockQueueAdd = jest.fn();
const mockQueueAddBulk = jest.fn();
const mockCreateQueue = jest.fn(() => ({
  add: mockQueueAdd,
  addBulk: mockQueueAddBulk,
}));
jest.mock('../interfaces/redis/queues', () => ({
  createQueue: (...args: unknown[]) => mockCreateQueue(...args),
  QUEUE_NAMES: {
    HEYGEN_GENERATE: 'heygen-generate',
    ELEVENLABS_GENERATE: 'elevenlabs-generate',
    WHATSAPP_PRELOAD: 'whatsapp-preload',
  },
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { MediaMetaDataService } from './media-meta-data.service';
import type { MediaMetaDataEntity } from './media-meta-data.entity';
import type { CacheService } from '../interfaces/redis/cache';
import type { UserService } from '../users/user.service';
import type { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';
import type { MediaBucketService } from '../interfaces/media-bucket/outbound/outbound.service';
import type { SarvamService } from '../interfaces/stt/sarvam/sarvam.service';
import type { AzureService } from '../interfaces/stt/azure/azure.service';
import type { ReverieService } from '../interfaces/stt/reverie/reverie.service';

type RepoMock = {
  findOneBy: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
};

function makeRepo(): RepoMock {
  return {
    findOneBy: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((row) => ({ ...row })),
    save: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function makeService(opts: {
  repo?: RepoMock;
  dsQuery?: jest.Mock;
  dsTransaction?: jest.Mock;
  cache?: Partial<CacheService>;
  userSvc?: Partial<UserService>;
  wabot?: Partial<WabotOutboundService>;
  bucket?: Partial<MediaBucketService>;
  sarvam?: Partial<SarvamService>;
  azure?: Partial<AzureService>;
  reverie?: Partial<ReverieService>;
}): { service: MediaMetaDataService; repo: RepoMock; ds: DataSource } {
  const repo = opts.repo ?? makeRepo();
  const ds = {
    query: opts.dsQuery ?? jest.fn(),
    transaction: opts.dsTransaction ?? jest.fn(),
  } as unknown as DataSource;
  return {
    service: new MediaMetaDataService(
      repo as unknown as Repository<MediaMetaDataEntity>,
      ds,
      (opts.cache ?? { get: jest.fn(), set: jest.fn(), del: jest.fn() }) as CacheService,
      (opts.userSvc ?? { find: jest.fn() }) as UserService,
      (opts.wabot ?? { downloadMedia: jest.fn() }) as WabotOutboundService,
      (opts.bucket ?? { stream: jest.fn(), delete: jest.fn() }) as MediaBucketService,
      (opts.sarvam ?? { run: jest.fn() }) as SarvamService,
      (opts.azure ?? { run: jest.fn() }) as AzureService,
      (opts.reverie ?? { run: jest.fn() }) as ReverieService,
    ),
    repo,
    ds,
  };
}

const carrier = { traceparent: 'tp' };

beforeEach(() => {
  mockQueueAdd.mockReset().mockResolvedValue(undefined);
  mockQueueAddBulk.mockReset().mockResolvedValue(undefined);
  mockCreateQueue.mockClear();
});

function makeAsyncStream(buf: Buffer): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield buf;
    },
  };
}

describe('MediaMetaDataService.createWhatsappAudioMedia', () => {
  it('resolves user via user_external_id and fails when not found', async () => {
    const userSvc = { find: jest.fn().mockResolvedValue(null) };
    const { service } = makeService({ userSvc });

    await expect(
      service.createWhatsappAudioMedia({
        wa_media_url: 'https://wa/m/1',
        user_external_id: '919999990001',
        otel_carrier: carrier,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('returns the existing row when wa_media_url already exists and status != failed', async () => {
    const repo = makeRepo();
    const existing = {
      id: 'mm-existing',
      wa_media_url: 'https://wa/m/1',
      status: 'ready',
    };
    repo.findOneBy.mockResolvedValue(existing);
    const { service } = makeService({ repo });

    const out = await service.createWhatsappAudioMedia({
      wa_media_url: 'https://wa/m/1',
      user: { id: 'u1' } as never,
      otel_carrier: carrier,
    });

    expect(out).toBe(existing);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('resets existing failed row to created and continues processing', async () => {
    const repo = makeRepo();
    const existing = {
      id: 'mm-existing',
      wa_media_url: 'https://wa/m/1',
      status: 'failed',
    };
    repo.findOneBy.mockResolvedValue(existing);
    repo.save.mockImplementation(async (e) => e);

    const wabot = {
      downloadMedia: jest.fn().mockResolvedValue({
        stream: makeAsyncStream(Buffer.from('audio')),
        content_type: 'audio/mpeg',
      }),
    };
    const bucket = { stream: jest.fn().mockResolvedValue('s3/key') };
    const sarvam = { run: jest.fn().mockResolvedValue({ id: 'stt-1' }) };
    const azure = { run: jest.fn().mockResolvedValue({ id: 'stt-2' }) };
    const reverie = { run: jest.fn().mockResolvedValue({ id: 'stt-3' }) };

    const { service } = makeService({
      repo,
      wabot,
      bucket,
      sarvam,
      azure,
      reverie,
    });

    const out = await service.createWhatsappAudioMedia({
      wa_media_url: 'https://wa/m/1',
      user: { id: 'u1' } as never,
      otel_carrier: carrier,
    });

    expect(out.status).toBe('ready');
    expect(out.s3_key).toBe('s3/key');
  });

  it('marks entity failed and rethrows when S3 upload fails', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => e);

    const wabot = {
      downloadMedia: jest.fn().mockResolvedValue({
        stream: makeAsyncStream(Buffer.from('a')),
        content_type: 'audio/mpeg',
      }),
    };
    const bucket = { stream: jest.fn().mockRejectedValue(new Error('s3 down')) };

    const { service } = makeService({ repo, wabot, bucket });

    await expect(
      service.createWhatsappAudioMedia({
        wa_media_url: 'https://wa/m/1',
        user: { id: 'u1' } as never,
        otel_carrier: carrier,
      }),
    ).rejects.toThrow('s3 down');

    // Last save call set status to failed.
    const failedSave = repo.save.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'failed',
    );
    expect(failedSave).toBeDefined();
  });

  it('marks failed and throws when every enabled STT provider fails', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => e);
    const wabot = {
      downloadMedia: jest.fn().mockResolvedValue({
        stream: makeAsyncStream(Buffer.from('a')),
        content_type: 'audio/mpeg',
      }),
    };
    const bucket = { stream: jest.fn().mockResolvedValue('s3/key') };
    // The defaults (sarvam:true, azure:true, reverie:false) are returned when
    // OpenFeature is unreachable — which is always under jest CJS. So sarvam +
    // azure both run.
    const sarvam = { run: jest.fn().mockRejectedValue(new Error('s1')) };
    const azure = { run: jest.fn().mockRejectedValue(new Error('s2')) };

    const { service } = makeService({ repo, wabot, bucket, sarvam, azure });

    await expect(
      service.createWhatsappAudioMedia({
        wa_media_url: 'https://wa/m/1',
        user: { id: 'u1' } as never,
        otel_carrier: carrier,
      }),
    ).rejects.toThrow('All STT providers failed');
  });
});

describe('MediaMetaDataService.createTextMedia', () => {
  it('throws NotFoundException when user lookup misses', async () => {
    const userSvc = { find: jest.fn().mockResolvedValue(null) };
    const { service } = makeService({ userSvc });
    await expect(
      service.createTextMedia({
        text: 'hi',
        user_external_id: '919999990001',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('inserts with default source=whatsapp when none provided', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, created_at: new Date() }));
    const { service } = makeService({ repo });

    const out = await service.createTextMedia({
      text: 'hi',
      user: { id: 'u1' } as never,
    });

    expect(out.source).toBe('whatsapp');
    expect(out.media_type).toBe('text');
    expect(out.status).toBe('ready');
  });

  it('respects an explicit source', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, created_at: new Date() }));
    const { service } = makeService({ repo });

    const out = await service.createTextMedia({
      text: 'hi',
      user: { id: 'u1' } as never,
      source: 'dashboard' as never,
    });

    expect(out.source).toBe('dashboard');
  });
});

describe('MediaMetaDataService.createTextMedia — optional fields', () => {
  it('forwards input_media_id and media_details when provided', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, created_at: new Date() }));
    const { service } = makeService({ repo });

    await service.createTextMedia({
      text: 'hi',
      user: { id: 'u1' } as never,
      input_media_id: 'parent-1',
      media_details: { foo: 'bar' },
    });

    const saved = repo.save.mock.calls[0][0] as {
      input_media_id: string;
      media_details: Record<string, unknown>;
    };
    expect(saved.input_media_id).toBe('parent-1');
    expect(saved.media_details).toEqual({ foo: 'bar' });
  });
});

describe('MediaMetaDataService.createHeygenMedia — optional generation_request_json fields', () => {
  it('includes only the optionals that were provided (and dropping env defaults)', async () => {
    process.env.HEYGEN_AVATAR_ID = 'env-av';
    process.env.HEYGEN_VOICE_ID = 'env-voice';
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, created_at: new Date() }));
    const { service } = makeService({ repo });

    await service.createHeygenMedia(
      {
        items: [
          {
            state_transition_id: 'stid-1',
            media_type: 'video',
            script_text: 'hi',
            // avatar_id MATCHES env default → must be omitted from JSON
            avatar_id: 'env-av',
            // voice_id DIFFERS from env default → must be included
            voice_id: 'custom-voice',
            avatar_style: 'circle',
            speed: 1.2,
            emotion: 'Excited',
            locale: 'en-IN',
            language: 'en',
            title: 't',
            dimension: { width: 1, height: 1 },
            background: { type: 'color', value: '#fff' },
          },
        ],
      },
      carrier,
    );

    const saved = repo.save.mock.calls[0][0] as {
      generation_request_json: Record<string, unknown>;
    };
    expect(saved.generation_request_json.avatar_id).toBeUndefined(); // matched env default
    expect(saved.generation_request_json.voice_id).toBe('custom-voice');
    expect(saved.generation_request_json.avatar_style).toBe('circle');
    expect(saved.generation_request_json.speed).toBe(1.2);
    expect(saved.generation_request_json.emotion).toBe('Excited');
    expect(saved.generation_request_json.locale).toBe('en-IN');
    expect(saved.generation_request_json.language).toBe('en');
    expect(saved.generation_request_json.title).toBe('t');
    expect(saved.generation_request_json.dimension).toEqual({ width: 1, height: 1 });
    expect(saved.generation_request_json.background).toEqual({ type: 'color', value: '#fff' });
  });
});

describe('MediaMetaDataService.createElevenlabsMedia — optional generation_request_json fields', () => {
  it('omits voice_id when it matches env default, includes model/language/voice_settings when provided', async () => {
    process.env.ELEVENLABS_VOICE_ID = 'env-elevenlabs-voice';
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, created_at: new Date() }));
    const { service } = makeService({ repo });

    await service.createElevenlabsMedia(
      {
        items: [
          {
            state_transition_id: 'stid-1',
            script_text: 'hi',
            voice_id: 'env-elevenlabs-voice', // matches env → omitted
            model_id: 'm-1',
            language_code: 'hi',
            voice_settings: { stability: 0.5 } as never,
          },
        ],
      },
      carrier,
    );

    const saved = repo.save.mock.calls[0][0] as {
      generation_request_json: Record<string, unknown>;
    };
    expect(saved.generation_request_json.voice_id).toBeUndefined();
    expect(saved.generation_request_json.model_id).toBe('m-1');
    expect(saved.generation_request_json.language_code).toBe('hi');
    expect(saved.generation_request_json.voice_settings).toEqual({ stability: 0.5 });
  });
});

describe('MediaMetaDataService.findTranscripts', () => {
  it('uses media_metadata.id when given the entity', async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValue([{ id: 't1' }]);
    const { service } = makeService({ repo });

    const out = await service.findTranscripts({
      media_metadata: { id: 'mm-1' } as never,
    });

    expect(repo.find).toHaveBeenCalledWith({
      where: { input_media_id: 'mm-1', media_type: 'text', status: 'ready' },
      order: { created_at: 'ASC' },
    });
    expect(out).toEqual([{ id: 't1' }]);
  });

  it('uses the provided media_metadata_id directly', async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValue([]);
    const { service } = makeService({ repo });

    await service.findTranscripts({ media_metadata_id: 'mm-1' });

    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ input_media_id: 'mm-1' }) }),
    );
  });

  it('resolves wa_media_url to id via findOneBy; returns [] when not found', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    const { service } = makeService({ repo });

    await expect(
      service.findTranscripts({
        media_metadata_wa_media_url: 'https://wa/m/1',
      }),
    ).resolves.toEqual([]);
  });

  it('returns the transcripts when wa_media_url resolves', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue({ id: 'mm-1' });
    repo.find.mockResolvedValue([{ id: 't1' }]);
    const { service } = makeService({ repo });

    const out = await service.findTranscripts({
      media_metadata_wa_media_url: 'https://wa/m/1',
    });

    expect(out).toEqual([{ id: 't1' }]);
  });
});

describe('MediaMetaDataService.findMediaByStateTransitionId', () => {
  it('throws BadRequest on empty stid', async () => {
    const { service } = makeService({});
    await expect(service.findMediaByStateTransitionId('')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('returns the cached value without hitting the DB', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue({ audio: { id: 'mm-cached' } }),
      set: jest.fn(),
      del: jest.fn(),
    };
    const dsQuery = jest.fn();
    const { service } = makeService({ cache, dsQuery });

    const out = await service.findMediaByStateTransitionId('क-letter-word-correct-last');
    expect(out).toEqual({ audio: { id: 'mm-cached' } });
    expect(dsQuery).not.toHaveBeenCalled();
  });

  it('looks up specific + generic key; specific wins per media_type', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn(),
    };
    const stid = 'क-letter-word-correct-last';
    const dsQuery = jest.fn().mockResolvedValue([
      {
        id: 'gen-1',
        media_type: 'audio',
        state_transition_id: '_-letter-word-correct-last',
      },
      {
        id: 'spec-1',
        media_type: 'audio',
        state_transition_id: stid,
      },
      {
        id: 'gen-text-1',
        media_type: 'text',
        state_transition_id: '_-letter-word-correct-last',
      },
    ]);
    const { service } = makeService({ cache, dsQuery });

    const out = await service.findMediaByStateTransitionId(stid);

    // audio: specific wins; text: only generic available
    expect(out.audio?.id).toBe('spec-1');
    expect(out.text?.id).toBe('gen-text-1');
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it('uses only the specific key when there is no dash', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
      del: jest.fn(),
    };
    const dsQuery = jest.fn().mockResolvedValue([]);
    const { service } = makeService({ cache, dsQuery });

    await service.findMediaByStateTransitionId('nostid');

    expect(dsQuery.mock.calls[0][1]).toEqual([['nostid']]);
  });

  it('does NOT write to cache when no media is found', async () => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
      del: jest.fn(),
    };
    const dsQuery = jest.fn().mockResolvedValue([]);
    const { service } = makeService({ cache, dsQuery });

    await service.findMediaByStateTransitionId('क-x');

    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('MediaMetaDataService.markRolledBack', () => {
  it('rejects an empty id', async () => {
    const { service } = makeService({});
    await expect(service.markRolledBack('')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('throws NotFoundException when UPDATE affects zero rows', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    const transaction = jest.fn().mockImplementation(async (cb) => {
      // The transaction body throws when affected=0
      return cb({
        query: jest.fn().mockResolvedValueOnce([[], 0]),
      });
    });
    const { service } = makeService({ repo, dsTransaction: transaction });

    await expect(service.markRolledBack('mm-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('invalidates STID cache and deletes S3 object on success', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue({
      id: 'mm-1',
      s3_key: 's3/key',
      state_transition_id: 'stid-1',
    });
    const transaction = jest.fn().mockImplementation(async (cb) => {
      const m = {
        query: jest
          .fn()
          .mockResolvedValueOnce([[], 1]) // UPDATE
          .mockResolvedValueOnce([{ sql: 'DELETE FROM x WHERE y = $1' }]) // FK stmts
          .mockResolvedValueOnce(undefined), // delete via FK
      };
      return cb(m);
    });
    const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn().mockResolvedValue(undefined) };
    const bucket = { stream: jest.fn(), delete: jest.fn().mockResolvedValue(undefined) };

    const { service } = makeService({
      repo,
      dsTransaction: transaction,
      cache,
      bucket,
    });

    await service.markRolledBack('mm-1');

    expect(cache.del).toHaveBeenCalledWith('media:stid:stid-1');
    expect(bucket.delete).toHaveBeenCalledWith('s3/key');
  });

  it('tolerates S3 delete failure (best-effort cleanup)', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue({
      id: 'mm-1',
      s3_key: 's3/key',
      state_transition_id: null,
    });
    const transaction = jest.fn().mockImplementation(async (cb) => {
      return cb({
        query: jest
          .fn()
          .mockResolvedValueOnce([[], 1])
          .mockResolvedValueOnce([]),
      });
    });
    const bucket = {
      stream: jest.fn(),
      delete: jest.fn().mockRejectedValue(new Error('s3 down')),
    };

    const { service } = makeService({
      repo,
      dsTransaction: transaction,
      bucket,
    });

    await expect(service.markRolledBack('mm-1')).resolves.toBeUndefined();
  });

  it('skips cache invalidation when entity has no state_transition_id, and skips S3 when no s3_key', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue({ id: 'mm-1', s3_key: null, state_transition_id: null });
    const transaction = jest.fn().mockImplementation(async (cb) => {
      return cb({
        query: jest
          .fn()
          .mockResolvedValueOnce([[], 1])
          .mockResolvedValueOnce([]),
      });
    });
    const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
    const bucket = { stream: jest.fn(), delete: jest.fn() };

    const { service } = makeService({
      repo,
      dsTransaction: transaction,
      cache,
      bucket,
    });
    await service.markRolledBack('mm-1');
    expect(cache.del).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });
});

describe('MediaMetaDataService.createHeygenMedia', () => {
  it('saves an entity per item, enqueues addBulk, marks rows queued', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, created_at: new Date() }));
    const { service } = makeService({ repo });

    const out = await service.createHeygenMedia(
      {
        items: [
          {
            state_transition_id: 'stid-1',
            media_type: 'video',
            script_text: 'hi',
          },
        ],
      },
      carrier,
    );

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(mockQueueAddBulk).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledTimes(1); // mark queued
    expect(out[0].status).toBe('queued');
  });

  it('on enqueue deadline (>10s): marks rows failed and throws', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, created_at: new Date() }));

    let now = 0;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockQueueAddBulk.mockImplementation(() => {
      now += 11_000;
      return Promise.reject(new Error('redis down'));
    });
    const { service } = makeService({ repo });

    await expect(
      service.createHeygenMedia(
        {
          items: [{ state_transition_id: 'stid-1', media_type: 'video', script_text: 'hi' }],
        },
        carrier,
      ),
    ).rejects.toThrow('redis down');

    // marked failed
    const failedUpdate = repo.update.mock.calls.find(
      (c) => (c[1] as { status: string }).status === 'failed',
    );
    expect(failedUpdate).toBeDefined();
    dateSpy.mockRestore();
  });
});

describe('MediaMetaDataService.createElevenlabsMedia', () => {
  it('mirrors heygen happy path (save + addBulk + mark queued)', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, created_at: new Date() }));
    const { service } = makeService({ repo });

    const out = await service.createElevenlabsMedia(
      {
        items: [
          { state_transition_id: 'stid-1', script_text: 'hello' },
        ],
      },
      carrier,
    );

    expect(out[0].status).toBe('queued');
    expect(mockQueueAddBulk).toHaveBeenCalled();
  });
});

describe('MediaMetaDataService.createRenderedImageMedia', () => {
  it('happy path: hashes, streams to S3, enqueues preload, returns queued entity', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, created_at: new Date() }));
    const bucket = { stream: jest.fn().mockResolvedValue('s3/key.png'), delete: jest.fn() };
    const { service } = makeService({ repo, bucket });

    const out = await service.createRenderedImageMedia({
      buffer: Buffer.from('png-bytes'),
      mime_type: 'image/png',
      user_id: 'u1',
      source: 'morning-update' as never,
      otel_carrier: carrier,
    });

    expect(out.status).toBe('queued');
    expect(out.s3_key).toBe('s3/key.png');
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it('marks entity failed and rethrows when S3 stream fails', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => e);
    const bucket = { stream: jest.fn().mockRejectedValue(new Error('s3 down')), delete: jest.fn() };
    const { service } = makeService({ repo, bucket });

    await expect(
      service.createRenderedImageMedia({
        buffer: Buffer.from('png-bytes'),
        mime_type: 'image/png',
        user_id: 'u1',
        source: 'morning-update' as never,
        otel_carrier: carrier,
      }),
    ).rejects.toThrow('s3 down');

    const failedSave = repo.save.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'failed',
    );
    expect(failedSave).toBeDefined();
  });

  it('marks entity failed when preload queue add fails', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => e);
    const bucket = { stream: jest.fn().mockResolvedValue('s3/key'), delete: jest.fn() };
    mockQueueAdd.mockRejectedValue(new Error('queue down'));

    const { service } = makeService({ repo, bucket });

    await expect(
      service.createRenderedImageMedia({
        buffer: Buffer.from('p'),
        mime_type: 'image/png',
        user_id: 'u1',
        source: 'morning-update' as never,
        otel_carrier: carrier,
      }),
    ).rejects.toThrow('queue down');
  });
});

describe('MediaMetaDataService.uploadStaticMedia', () => {
  it('text item — fresh create returns {status:created}', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => ({ ...e, created_at: new Date() }));
    const { service } = makeService({ repo });

    const out = await service.uploadStaticMedia(
      [],
      [
        {
          state_transition_id: 'stid-1',
          media_type: 'text',
          text: 'hello',
        } as never,
      ],
      carrier,
    );

    expect(out.results).toHaveLength(1);
    expect(out.results[0].status).toBe('created');
    expect(out.summary.created).toBe(1);
  });

  it('text item — duplicate-ready returns {status:duplicate_skipped}', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({ id: 'mm-existing', status: 'ready' });
    const { service } = makeService({ repo });

    const out = await service.uploadStaticMedia(
      [],
      [
        {
          state_transition_id: 'stid-1',
          media_type: 'text',
          text: 'hello',
        } as never,
      ],
      carrier,
    );

    expect(out.results[0].status).toBe('duplicate_skipped');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('text item — duplicate-failed gets reset and saved', async () => {
    const repo = makeRepo();
    const dup = { id: 'mm-1', status: 'failed', rolled_back: true };
    repo.findOne.mockResolvedValue(dup);
    repo.save.mockImplementation(async (e) => e);
    const { service } = makeService({ repo });

    const out = await service.uploadStaticMedia(
      [],
      [
        {
          state_transition_id: 'stid-1',
          media_type: 'text',
          text: 'hello',
        } as never,
      ],
      carrier,
    );

    expect(out.results[0].status).toBe('created');
    // status set to 'ready', rolled_back reset to false
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready', rolled_back: false }),
    );
  });

  it('non-text item — happy path: hash + dedup miss + S3 + enqueue + mark queued', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => ({ ...e, created_at: new Date() }));
    const bucket = { stream: jest.fn().mockResolvedValue('s3/key'), delete: jest.fn() };

    const { service } = makeService({ repo, bucket });

    const file = {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      size: 3,
      originalname: 'a.jpg',
    } as Express.Multer.File;

    const out = await service.uploadStaticMedia(
      [file],
      [
        { state_transition_id: 'stid-1', media_type: 'image' } as never,
      ],
      carrier,
    );

    expect(out.results[0].status).toBe('created');
    expect(out.summary.created).toBe(1);
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it('non-text item — mime/media_type mismatch is captured as a per-item failure (continues loop)', async () => {
    const repo = makeRepo();
    const { service } = makeService({ repo });

    const file = {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg', // would map to "image"
      size: 3,
      originalname: 'a.jpg',
    } as Express.Multer.File;

    const out = await service.uploadStaticMedia(
      [file],
      [
        // Caller said video but the file is a jpeg — mismatch
        { state_transition_id: 'stid-1', media_type: 'video' } as never,
      ],
      carrier,
    );

    expect(out.results[0].status).toBe('failed');
    expect(out.summary.failed).toBe(1);
  });

  it('non-text item — dedup-ready returns {duplicate_skipped} and skips S3 upload', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({ id: 'mm-existing', status: 'ready' });
    const bucket = { stream: jest.fn(), delete: jest.fn() };
    const { service } = makeService({ repo, bucket });

    const file = {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      size: 3,
      originalname: 'a.jpg',
    } as Express.Multer.File;

    const out = await service.uploadStaticMedia(
      [file],
      [{ state_transition_id: 'stid-1', media_type: 'image' } as never],
      carrier,
    );

    expect(out.results[0].status).toBe('duplicate_skipped');
    expect(bucket.stream).not.toHaveBeenCalled();
  });

  it('non-text item — S3 upload failure is captured as a per-item failure (continues loop)', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    const bucket = { stream: jest.fn().mockRejectedValue(new Error('s3 down')), delete: jest.fn() };

    const { service } = makeService({ repo, bucket });

    const file = {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      size: 3,
      originalname: 'a.jpg',
    } as Express.Multer.File;

    const out = await service.uploadStaticMedia(
      [file],
      [{ state_transition_id: 'stid-1', media_type: 'image' } as never],
      carrier,
    );

    expect(out.results[0].status).toBe('failed');
  });

  it('non-text item — queue add failure marks entity failed and records as failure result', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => ({ ...e }));
    const bucket = { stream: jest.fn().mockResolvedValue('s3/key'), delete: jest.fn() };
    mockQueueAdd.mockRejectedValue(new Error('queue down'));

    const { service } = makeService({ repo, bucket });

    const file = {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      size: 3,
      originalname: 'a.jpg',
    } as Express.Multer.File;

    const out = await service.uploadStaticMedia(
      [file],
      [{ state_transition_id: 'stid-1', media_type: 'image' } as never],
      carrier,
    );

    expect(out.results[0].status).toBe('failed');
    // entity.status was set to 'failed' on a save
    const failedSave = repo.save.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'failed',
    );
    expect(failedSave).toBeDefined();
  });
});
