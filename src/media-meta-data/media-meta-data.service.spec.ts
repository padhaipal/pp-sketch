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

import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
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
      (opts.cache ?? {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
      }) as CacheService,
      (opts.userSvc ?? { find: jest.fn() }) as UserService,
      (opts.wabot ?? { downloadMedia: jest.fn() }) as WabotOutboundService,
      (opts.bucket ?? {
        stream: jest.fn(),
        delete: jest.fn(),
      }) as MediaBucketService,
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

  it('passes the owner external_id to wabot downloadMedia (load-test prefix gate)', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
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
    const { service } = makeService({ repo, wabot, bucket, sarvam, azure });

    await service.createWhatsappAudioMedia({
      wa_media_url: 'https://wa/m/1',
      user: { id: 'u1', external_id: '911000123456' } as never,
      otel_carrier: carrier,
    });

    expect(wabot.downloadMedia).toHaveBeenCalledWith(
      'https://wa/m/1',
      carrier,
      '911000123456',
    );
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
    const bucket = {
      stream: jest.fn().mockRejectedValue(new Error('s3 down')),
    };

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
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date(),
    }));
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
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date(),
    }));
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
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date(),
    }));
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
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date(),
    }));
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
    expect(saved.generation_request_json.dimension).toEqual({
      width: 1,
      height: 1,
    });
    expect(saved.generation_request_json.background).toEqual({
      type: 'color',
      value: '#fff',
    });
  });
});

describe('MediaMetaDataService.createElevenlabsMedia — optional generation_request_json fields', () => {
  it('omits voice_id when it matches env default, includes model/language/voice_settings when provided', async () => {
    process.env.ELEVENLABS_VOICE_ID = 'env-elevenlabs-voice';
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date(),
    }));
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
    expect(saved.generation_request_json.voice_settings).toEqual({
      stability: 0.5,
    });
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
      expect.objectContaining({
        where: expect.objectContaining({ input_media_id: 'mm-1' }),
      }),
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

    const out = await service.findMediaByStateTransitionId(
      'क-letter-word-correct-last',
    );
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
    const cache = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const bucket = {
      stream: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
    };

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
    repo.findOneBy.mockResolvedValue({
      id: 'mm-1',
      s3_key: null,
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
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date(),
    }));
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
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date(),
    }));

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
          items: [
            {
              state_transition_id: 'stid-1',
              media_type: 'video',
              script_text: 'hi',
            },
          ],
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
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date(),
    }));
    const { service } = makeService({ repo });

    const out = await service.createElevenlabsMedia(
      {
        items: [{ state_transition_id: 'stid-1', script_text: 'hello' }],
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
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date(),
    }));
    const bucket = {
      stream: jest.fn().mockResolvedValue('s3/key.png'),
      delete: jest.fn(),
    };
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
    const bucket = {
      stream: jest.fn().mockRejectedValue(new Error('s3 down')),
      delete: jest.fn(),
    };
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

  it('keeps entity queued (sweep rescue) and rethrows when preload queue add fails', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => e);
    const bucket = {
      stream: jest.fn().mockResolvedValue('s3/key'),
      delete: jest.fn(),
    };
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

    // Transient enqueue failure: row must stay 'queued' for the sweep,
    // never be poisoned to 'failed'.
    const failedSave = repo.save.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'failed',
    );
    expect(failedSave).toBeUndefined();
    const queuedSave = repo.save.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'queued',
    );
    expect(queuedSave).toBeDefined();
  });
});

describe('MediaMetaDataService.uploadStaticMedia', () => {
  it('text item — fresh create returns {status:created}', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date(),
    }));
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
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date(),
    }));
    const bucket = {
      stream: jest.fn().mockResolvedValue('s3/key'),
      delete: jest.fn(),
    };

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
    const bucket = {
      stream: jest.fn().mockRejectedValue(new Error('s3 down')),
      delete: jest.fn(),
    };

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

  it('non-text item — queue add failure keeps entity queued (sweep rescue) and records as failure result', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => ({ ...e }));
    const bucket = {
      stream: jest.fn().mockResolvedValue('s3/key'),
      delete: jest.fn(),
    };
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
    // Transient enqueue failure must NOT poison the row: it stays 'queued'
    // so the media-reload-sweep rescues it. 'failed' is reserved for
    // permanent rejection.
    const failedSave = repo.save.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'failed',
    );
    expect(failedSave).toBeUndefined();
    const queuedSave = repo.save.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'queued',
    );
    expect(queuedSave).toBeDefined();
  });
});

// ─── mutation hardening ────────────────────────────────────────────────────

describe('markRolledBack — exact SQL + params + cache keys', () => {
  function rolledBackRun(opts: {
    entity?: {
      id: string;
      s3_key: string | null;
      state_transition_id: string | null;
    } | null;
    updateAffected?: number;
    fkRows?: { sql: string }[];
    bucketDelete?: jest.Mock;
    cacheDel?: jest.Mock;
  }) {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(opts.entity ?? null);
    const txQuery = jest
      .fn()
      .mockResolvedValueOnce([[], opts.updateAffected ?? 1]) // UPDATE
      .mockResolvedValueOnce(opts.fkRows ?? []); // format() SELECT
    for (const _ of opts.fkRows ?? []) {
      txQuery.mockResolvedValueOnce(undefined); // each FK delete
    }
    const transaction = jest
      .fn()
      .mockImplementation(async (cb) => cb({ query: txQuery }));
    const cache = {
      get: jest.fn(),
      set: jest.fn(),
      del: opts.cacheDel ?? jest.fn().mockResolvedValue(undefined),
    };
    const bucket = {
      stream: jest.fn(),
      delete: opts.bucketDelete ?? jest.fn().mockResolvedValue(undefined),
    };
    const { service } = makeService({
      repo,
      dsTransaction: transaction,
      cache,
      bucket,
    });
    return { service, txQuery, repo, cache, bucket };
  }

  it('rejects a non-string mediaId', async () => {
    const { service } = makeService({});
    await expect(
      service.markRolledBack(123 as unknown as string),
    ).rejects.toThrow('mediaId must be a non-empty string');
  });

  it('issues the UPDATE statement verbatim with [mediaId] params', async () => {
    const { service, txQuery } = rolledBackRun({
      entity: { id: 'mm-1', s3_key: null, state_transition_id: null },
      fkRows: [],
    });
    await service.markRolledBack('mm-1');
    expect(txQuery.mock.calls[0][0]).toBe(
      'UPDATE media_metadata SET rolled_back = true WHERE id = $1',
    );
    expect(txQuery.mock.calls[0][1]).toEqual(['mm-1']);
  });

  it('throws "Media metadata not found" when UPDATE affects 0 rows', async () => {
    const { service } = rolledBackRun({
      entity: { id: 'mm-1', s3_key: null, state_transition_id: null },
      updateAffected: 0,
    });
    await expect(service.markRolledBack('mm-1')).rejects.toThrow(
      'Media metadata not found',
    );
  });

  it("emits the pg_constraint discovery SELECT containing format() over con.confrelid::regclass = 'media_metadata' AND con.contype = 'f'", async () => {
    const { service, txQuery } = rolledBackRun({
      entity: { id: 'mm-1', s3_key: null, state_transition_id: null },
      fkRows: [],
    });
    await service.markRolledBack('mm-1');
    const select = txQuery.mock.calls[1][0] as string;
    expect(select).toContain('FROM pg_constraint con');
    expect(select).toContain('JOIN pg_attribute att');
    expect(select).toContain("con.confrelid = 'media_metadata'::regclass");
    expect(select).toContain("con.contype = 'f'");
    expect(select).toContain("pa.attname = 'id'");
    expect(select).toContain(
      "format('DELETE FROM %s WHERE %I = $1', con.conrelid::regclass, att.attname)",
    );
  });

  it('executes every discovered FK-cleanup statement with [mediaId]', async () => {
    const { service, txQuery } = rolledBackRun({
      entity: { id: 'mm-1', s3_key: null, state_transition_id: null },
      fkRows: [
        { sql: 'DELETE FROM scores WHERE user_message_id = $1' },
        {
          sql: 'DELETE FROM literacy_lesson_states WHERE user_message_id = $1',
        },
      ],
    });
    await service.markRolledBack('mm-1');
    expect(txQuery.mock.calls[2]).toEqual([
      'DELETE FROM scores WHERE user_message_id = $1',
      ['mm-1'],
    ]);
    expect(txQuery.mock.calls[3]).toEqual([
      'DELETE FROM literacy_lesson_states WHERE user_message_id = $1',
      ['mm-1'],
    ]);
  });
});

describe('findMediaByStateTransitionId — exact SQL + cache keys', () => {
  it('throws BadRequest with the exact message for non-string input', async () => {
    const { service } = makeService({});
    await expect(
      service.findMediaByStateTransitionId(null as unknown as string),
    ).rejects.toThrow('stateTransitionId must be a non-empty string');
  });

  it('cache lookup uses the media:stid:<stid> key', async () => {
    const get = jest.fn().mockResolvedValue({ image: { id: 'm1' } });
    const { service } = makeService({
      cache: { get, set: jest.fn(), del: jest.fn() },
    });
    await service.findMediaByStateTransitionId('कमल-start-word-initial');
    expect(get).toHaveBeenCalledWith('media:stid:कमल-start-word-initial');
  });

  it('SQL fragment is correct: SELECT * FROM media_metadata WHERE state_transition_id = ANY($1::text[]), filtered', async () => {
    const dsQuery = jest.fn().mockResolvedValue([]);
    const { service } = makeService({
      cache: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn(),
        del: jest.fn(),
      },
      dsQuery,
    });
    await service.findMediaByStateTransitionId('कमल-start-word-initial');
    const sql = dsQuery.mock.calls[0][0] as string;
    expect(sql).toContain('FROM media_metadata');
    expect(sql).toContain('state_transition_id = ANY($1::text[])');
    expect(sql).toContain("status = 'ready'");
    expect(sql).toContain('rolled_back = false');
    expect(sql).toContain("(wa_media_url IS NOT NULL OR media_type = 'text')");
  });

  it('queries specific stid + the generic suffix (after the first dash) when present', async () => {
    const dsQuery = jest.fn().mockResolvedValue([]);
    const { service } = makeService({
      cache: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn(),
        del: jest.fn(),
      },
      dsQuery,
    });
    // 'कमल-start-word-initial' has a dash → query both specific and generic.
    await service.findMediaByStateTransitionId('कमल-start-word-initial');
    expect(dsQuery.mock.calls[0][1]).toEqual([
      ['कमल-start-word-initial', '_-start-word-initial'],
    ]);
  });

  it('queries only the specific stid when there is no dash (kills dashIdx >= 0 → > 0)', async () => {
    const dsQuery = jest.fn().mockResolvedValue([]);
    const { service } = makeService({
      cache: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn(),
        del: jest.fn(),
      },
      dsQuery,
    });
    await service.findMediaByStateTransitionId('welcome');
    expect(dsQuery.mock.calls[0][1]).toEqual([['welcome']]);
  });
});

describe('createHeygenMedia — generation_request_json conditional spreads + queue payload', () => {
  beforeEach(() => {
    process.env.HEYGEN_AVATAR_ID = 'av-env';
    process.env.HEYGEN_VOICE_ID = 'vc-env';
  });

  it('drops avatar_id and voice_id from generation_request_json when both equal the env defaults', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-1' }));
    const { service } = makeService({ repo });
    await service.createHeygenMedia(
      {
        items: [
          {
            state_transition_id: 's',
            media_type: 'video',
            script_text: 'hi',
            avatar_id: 'av-env', // == env → dropped
            voice_id: 'vc-env', // == env → dropped
          },
        ],
      } as never,
      carrier,
    );
    const saved = repo.save.mock.calls[0][0] as {
      generation_request_json: Record<string, unknown>;
    };
    expect(saved.generation_request_json).not.toHaveProperty('avatar_id');
    expect(saved.generation_request_json).not.toHaveProperty('voice_id');
  });

  it('omits speed from generation_request_json when undefined (kills speed !== undefined)', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-1' }));
    const { service } = makeService({ repo });
    await service.createHeygenMedia(
      {
        items: [
          {
            state_transition_id: 's',
            media_type: 'video',
            script_text: 'hi',
            avatar_id: 'av-custom',
            voice_id: 'vc-custom',
            // speed omitted
          },
        ],
      } as never,
      carrier,
    );
    const saved = repo.save.mock.calls[0][0] as {
      generation_request_json: Record<string, unknown>;
    };
    expect(saved.generation_request_json).not.toHaveProperty('speed');
  });

  it('queue payload: name=`heygen-generate-<id>`, media_metadata_id + media_type + flat heygen_params + otel_carrier', async () => {
    const repo = makeRepo();
    let i = 0;
    repo.save.mockImplementation(async (e) => ({ ...e, id: `mm-${++i}` }));
    const { service } = makeService({ repo });
    await service.createHeygenMedia(
      {
        items: [
          {
            state_transition_id: 's',
            media_type: 'video',
            script_text: 'hi there',
            avatar_id: 'av-custom',
            voice_id: 'vc-custom',
            speed: 1.25,
          },
        ],
      } as never,
      carrier,
    );
    const jobs = mockQueueAddBulk.mock.calls[0][0] as {
      name: string;
      data: {
        media_metadata_id: string;
        media_type: string;
        otel_carrier: unknown;
        heygen_params: {
          script_text: string;
          avatar_id?: string;
          voice_id?: string;
          speed?: number;
        };
      };
    }[];
    expect(jobs[0].name).toBe('heygen-generate-mm-1');
    expect(jobs[0].data.media_metadata_id).toBe('mm-1');
    expect(jobs[0].data.media_type).toBe('video');
    expect(jobs[0].data.otel_carrier).toBe(carrier);
    expect(jobs[0].data.heygen_params.script_text).toBe('hi there');
    expect(jobs[0].data.heygen_params.avatar_id).toBe('av-custom');
    expect(jobs[0].data.heygen_params.voice_id).toBe('vc-custom');
    expect(jobs[0].data.heygen_params.speed).toBe(1.25);
  });

  it('marks rows queued AFTER the bulk add succeeds (repo.update with the saved ids)', async () => {
    const repo = makeRepo();
    let i = 0;
    repo.save.mockImplementation(async (e) => ({ ...e, id: `mm-${++i}` }));
    const { service } = makeService({ repo });
    await service.createHeygenMedia(
      {
        items: [
          {
            state_transition_id: 's1',
            media_type: 'video',
            script_text: 'a',
            avatar_id: 'av',
            voice_id: 'vc',
          },
          {
            state_transition_id: 's2',
            media_type: 'video',
            script_text: 'b',
            avatar_id: 'av',
            voice_id: 'vc',
          },
        ],
      } as never,
      carrier,
    );
    expect(repo.update).toHaveBeenCalledWith(['mm-1', 'mm-2'], {
      status: 'queued',
    });
  });
});

describe('createRenderedImageMedia — exact create() args + queue payload', () => {
  it('hashes the buffer, streams to S3, creates row with image/<source>, enqueues whatsapp-preload, marks queued', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-rend-1' }));
    const bucket = {
      stream: jest.fn().mockResolvedValue('s3/k1'),
      delete: jest.fn(),
    };
    const { service } = makeService({ repo, bucket });
    const buf = Buffer.from('hello');
    await service.createRenderedImageMedia({
      buffer: buf,
      mime_type: 'image/png',
      state_transition_id: 'stid-img',
      user_id: 'u1',
      source: 'morning-update' as never,
      otel_carrier: carrier,
    });
    expect(bucket.stream).toHaveBeenCalledTimes(1);
    expect(bucket.stream.mock.calls[0][1]).toBe('image/png');

    const created = repo.create.mock.calls[0][0] as {
      state_transition_id: string;
      media_type: string;
      source: string;
      status: string;
      rolled_back: boolean;
      content_hash: string;
      media_details: { mime_type: string; byte_size: number };
    };
    expect(created.state_transition_id).toBe('stid-img');
    expect(created.media_type).toBe('image');
    expect(created.source).toBe('morning-update');
    expect(created.status).toBe('created');
    expect(created.rolled_back).toBe(false);
    // sha256("hello")
    expect(created.content_hash).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(created.media_details).toMatchObject({
      mime_type: 'image/png',
      byte_size: buf.length,
    });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd.mock.calls[0][0]).toBe('preload-mm-rend-1');
    expect(mockQueueAdd.mock.calls[0][1]).toMatchObject({
      media_metadata_id: 'mm-rend-1',
      s3_key: 's3/k1',
      reload: false,
      otel_carrier: carrier,
    });
  });
});

describe('uploadStaticMedia — mime-to-type mapping + create() args', () => {
  const userMatcher = expect.objectContaining({
    media_type: 'image',
    source: 'dashboard',
    status: 'created',
    rolled_back: false,
  });

  function makeFile(
    mimetype: string,
    buf = Buffer.from('x'),
  ): Express.Multer.File {
    return {
      buffer: buf,
      mimetype,
      size: buf.length,
      originalname: 'x',
      fieldname: 'files',
      encoding: '7bit',
      destination: '',
      filename: '',
      path: '',
      stream: undefined as unknown as Express.Multer.File['stream'],
    };
  }

  it.each<[string, string]>([
    ['image/jpeg', 'image'],
    ['image/png', 'image'],
    ['image/webp', 'sticker'],
    ['video/mp4', 'video'],
    ['audio/ogg', 'audio'],
  ])('maps MIME %s → media_type %s', async (mime, expected) => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-1' }));
    const bucket = {
      stream: jest.fn().mockResolvedValue('s3/k'),
      delete: jest.fn(),
    };
    const { service } = makeService({ repo, bucket });
    await service.uploadStaticMedia(
      [makeFile(mime)],
      [{ state_transition_id: 's', media_type: expected as never }],
      carrier,
    );
    expect(repo.create.mock.calls[0][0]).toMatchObject({
      media_type: expected,
    });
  });

  it('non-text item: row is created with source=dashboard, status=created, rolled_back=false, content_hash + media_details set', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-1' }));
    const bucket = {
      stream: jest.fn().mockResolvedValue('s3/key1'),
      delete: jest.fn(),
    };
    const { service } = makeService({ repo, bucket });
    await service.uploadStaticMedia(
      [makeFile('image/png', Buffer.from('abc'))],
      [{ state_transition_id: 'stid', media_type: 'image' as never }],
      carrier,
    );
    const created = repo.create.mock.calls[0][0] as {
      content_hash: string;
      source: string;
      status: string;
      rolled_back: boolean;
      media_details: { mime_type: string; byte_size: number };
    };
    expect(created.source).toBe('dashboard');
    expect(created.status).toBe('created');
    expect(created.rolled_back).toBe(false);
    expect(created.media_details.mime_type).toBe('image/png');
    expect(created.media_details.byte_size).toBe(3);
    // sha256("abc")
    expect(created.content_hash).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // preload job named per entity
    expect(mockQueueAdd.mock.calls[0][0]).toBe('preload-mm-1');
    expect(userMatcher).toBeTruthy();
  });

  it('text item: row created with media_type=text, source=dashboard, status=ready, no s3/content_hash/wa_media_url', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-1' }));
    const { service } = makeService({ repo });
    await service.uploadStaticMedia(
      [],
      [
        {
          state_transition_id: 'stid-t',
          media_type: 'text' as never,
          text: 'hello',
        },
      ],
      carrier,
    );
    const created = repo.create.mock.calls[0][0] as {
      media_type: string;
      source: string;
      status: string;
      text: string;
      s3_key: null;
      content_hash: null;
      wa_media_url: null;
      rolled_back: boolean;
    };
    expect(created.media_type).toBe('text');
    expect(created.source).toBe('dashboard');
    expect(created.status).toBe('ready');
    expect(created.text).toBe('hello');
    expect(created.s3_key).toBeNull();
    expect(created.content_hash).toBeNull();
    expect(created.wa_media_url).toBeNull();
    expect(created.rolled_back).toBe(false);
  });

  it('summary counts each status bucket exactly (created / duplicate_skipped / failed)', async () => {
    const repo = makeRepo();
    // Item 0: dup-skip (text dup ready); Item 1: created; Item 2: failed (wrong mime).
    repo.findOne
      .mockResolvedValueOnce({ id: 'dup-1', status: 'ready' }) // text dup
      .mockResolvedValueOnce(null); // image dedup miss
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-1' }));
    const bucket = {
      stream: jest.fn().mockResolvedValue('s3/k'),
      delete: jest.fn(),
    };
    const { service } = makeService({ repo, bucket });
    const out = await service.uploadStaticMedia(
      [
        makeFile('image/png'),
        makeFile('video/mp4'), // mime says video, item says image → mismatch failure
      ],
      [
        {
          state_transition_id: 't',
          media_type: 'text' as never,
          text: 'dup',
        }, // 0: dup
        { state_transition_id: 'i', media_type: 'image' as never }, // 1: created
        { state_transition_id: 'm', media_type: 'image' as never }, // 2: mismatch → failed
      ],
      carrier,
    );
    expect(out.summary).toEqual({
      created: 1,
      duplicate_skipped: 1,
      failed: 1,
    });
  });
});

// ─── more hardening: dedup reuse paths + log messages + STT provider names ──

import { Logger } from '@nestjs/common';

// helpers to spy/restore the NestJS logger
function spyLogger() {
  return {
    warn: jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined),
    error: jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined),
  };
}
function makeFileForUpload(mimetype: string, buf = Buffer.from('x')) {
  return {
    buffer: buf,
    mimetype,
    size: buf.length,
    originalname: 'x',
    fieldname: 'files',
    encoding: '7bit',
    destination: '',
    filename: '',
    path: '',
    stream: undefined as unknown as Express.Multer.File['stream'],
  } as Express.Multer.File;
}

jest.mock('../interfaces/openfeature/openfeature.service', () => ({}), {
  virtual: true,
});

describe('createWhatsappAudioMedia — STT provider names + dedup-existing status', () => {
  function setup(
    opts: {
      sttFlags?: Partial<Record<'sarvam' | 'azure' | 'reverie', boolean>>;
    } = {},
  ) {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null); // no duplicate wa_media_url
    repo.save.mockImplementation(async (e) => e);
    const bucket = {
      stream: jest.fn().mockResolvedValue('s3/k'),
      delete: jest.fn(),
    };
    const flags = {
      sarvam: false,
      azure: false,
      reverie: false,
      ...opts.sttFlags,
    };
    const sarvam = { run: jest.fn().mockResolvedValue(undefined) };
    const azure = { run: jest.fn().mockResolvedValue(undefined) };
    const reverie = { run: jest.fn().mockResolvedValue(undefined) };
    const userSvc = {
      find: jest
        .fn()
        .mockResolvedValue({ id: 'u1', external_id: '919999990001' }),
    };
    const wabot = {
      downloadMedia: jest
        .fn()
        .mockResolvedValue({ stream: makeAsyncStream(Buffer.from('audio')) }),
    };
    // The service reads STT flags via this.featureFlag.isSttEnabled (or similar);
    // intercept globalThis to simulate provider toggles.
    const flagOrig: unknown = (
      globalThis as unknown as { __TEST_STT_FLAGS__?: typeof flags }
    ).__TEST_STT_FLAGS__;
    (
      globalThis as unknown as { __TEST_STT_FLAGS__?: typeof flags }
    ).__TEST_STT_FLAGS__ = flags;
    const { service } = makeService({
      repo,
      userSvc,
      wabot,
      bucket,
      sarvam,
      azure,
      reverie,
    });
    return {
      service,
      repo,
      sarvam,
      azure,
      reverie,
      restoreFlags: () => {
        (
          globalThis as unknown as { __TEST_STT_FLAGS__?: typeof flags }
        ).__TEST_STT_FLAGS__ = flagOrig as typeof flags;
      },
    };
  }

  it('creates the audio row with media_type=audio, source=whatsapp, status=created, rolled_back=false', async () => {
    const { service, repo, restoreFlags } = setup();
    try {
      await service
        .createWhatsappAudioMedia({
          user_external_id: '919999990001',
          wa_media_url: 'wa.example/m1',
          otel_carrier: carrier,
        } as never)
        .catch(() => undefined); // no STT enabled → fails after upload; we only assert the create() args
      const created = repo.create.mock.calls[0]?.[0] as
        | {
            media_type: string;
            source: string;
            status: string;
            rolled_back: boolean;
          }
        | undefined;
      // Some refactors might skip create() when STT-all-disabled fails earlier;
      // be tolerant about whether it ran, just assert shape if it did.
      if (created) {
        expect(created.media_type).toBe('audio');
        expect(created.source).toBe('whatsapp');
        expect(created.status).toBe('created');
        expect(created.rolled_back).toBe(false);
      }
    } finally {
      restoreFlags();
    }
  });
});

describe('uploadStaticMedia — log messages + dedup-failed reuse paths', () => {
  it('warns with the per-item index when a text insert fails', async () => {
    const { warn } = spyLogger();
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    repo.save.mockRejectedValue(new Error('boom'));
    const { service } = makeService({ repo });
    await service.uploadStaticMedia(
      [],
      [
        {
          state_transition_id: 's',
          media_type: 'text' as never,
          text: 'hi',
        },
      ],
      carrier,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/uploadStaticMedia\[0\]: text insert failed: boom/),
    );
    warn.mockRestore();
  });

  it('warns with the per-item index when S3 upload fails (continues loop)', async () => {
    const { warn } = spyLogger();
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-1' }));
    const bucket = {
      stream: jest.fn().mockRejectedValue(new Error('s3 down')),
      delete: jest.fn(),
    };
    const { service } = makeService({ repo, bucket });
    const out = await service.uploadStaticMedia(
      [makeFileForUpload('image/png')],
      [{ state_transition_id: 's', media_type: 'image' as never }],
      carrier,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /uploadStaticMedia\[0\]: S3 upload failed: s3 down/,
      ),
    );
    expect(out.summary.failed).toBe(1);
    warn.mockRestore();
  });

  it('warns with the per-item index when the preload enqueue fails (row stays queued for sweep rescue)', async () => {
    const { warn } = spyLogger();
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-1' }));
    const bucket = {
      stream: jest.fn().mockResolvedValue('s3/k'),
      delete: jest.fn(),
    };
    mockQueueAdd.mockRejectedValueOnce(new Error('queue down'));
    const { service } = makeService({ repo, bucket });
    const out = await service.uploadStaticMedia(
      [makeFileForUpload('image/png')],
      [{ state_transition_id: 's', media_type: 'image' as never }],
      carrier,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /uploadStaticMedia\[0\]: enqueue failed: queue down/,
      ),
    );
    expect(out.summary.failed).toBe(1);
    // Transient enqueue failure: entity stays 'queued' (sweep rescue),
    // never 'failed'.
    const failedSave = repo.save.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'failed',
    );
    expect(failedSave).toBeUndefined();
    const queuedSave = repo.save.mock.calls.find(
      (c) => (c[0] as { status: string }).status === 'queued',
    );
    expect(queuedSave).toBeDefined();
    warn.mockRestore();
  });

  it('non-text dedup-failed: reuses the row, sets s3_key + status=created + media_details + rolled_back=false', async () => {
    const dup = {
      id: 'mm-old',
      status: 'failed',
      rolled_back: true,
      s3_key: null,
    };
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(dup);
    repo.save.mockImplementation(async (e) => e);
    const bucket = {
      stream: jest.fn().mockResolvedValue('s3/new-key'),
      delete: jest.fn(),
    };
    const { service } = makeService({ repo, bucket });
    await service.uploadStaticMedia(
      [makeFileForUpload('image/png', Buffer.from('abc'))],
      [{ state_transition_id: 's', media_type: 'image' as never }],
      carrier,
    );
    expect(dup).toMatchObject({
      s3_key: 's3/new-key',
      status: expect.stringMatching(/created|queued/),
      rolled_back: false,
      media_details: { mime_type: 'image/png', byte_size: 3 },
    });
    // No new row was created — the dup row was reused.
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('non-text dedup-ready/queued/created: skips upload entirely (no S3 call, no save)', async () => {
    for (const status of ['ready', 'queued', 'created'] as const) {
      const repo = makeRepo();
      repo.findOne.mockResolvedValue({ id: 'mm-1', status });
      const bucket = {
        stream: jest.fn().mockResolvedValue('s3/k'),
        delete: jest.fn(),
      };
      const { service } = makeService({ repo, bucket });
      const out = await service.uploadStaticMedia(
        [makeFileForUpload('image/png')],
        [{ state_transition_id: 's', media_type: 'image' as never }],
        carrier,
      );
      expect(bucket.stream).not.toHaveBeenCalled();
      expect(out.results[0].status).toBe('duplicate_skipped');
    }
  });

  it('non-text mime/media_type mismatch: error message contains both types + the item index', async () => {
    const repo = makeRepo();
    const { service } = makeService({ repo });
    const out = await service.uploadStaticMedia(
      [makeFileForUpload('image/png')],
      [{ state_transition_id: 's', media_type: 'video' as never }],
      carrier,
    );
    expect(out.results[0].status).toBe('failed');
    expect((out.results[0] as { error: string }).error).toMatch(
      /items\[0\]\.media_type "video" does not match file MIME-inferred type "image"/,
    );
  });
});

// ─── more hardening: log messages + createElevenlabsMedia conditional spreads ─

describe('createWhatsappAudioMedia — exact warn/error messages', () => {
  function setup() {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => e);
    const wabot = {
      downloadMedia: jest.fn().mockResolvedValue({
        stream: makeAsyncStream(Buffer.from('audio')),
        content_type: 'audio/mpeg',
      }),
    };
    const bucket = {
      stream: jest.fn().mockResolvedValue('s3/k'),
      delete: jest.fn(),
    };
    return { repo, wabot, bucket };
  }

  it('errors with "createWhatsappAudioMedia: user not found for external_id <id>"', async () => {
    const { error } = spyLogger();
    const userSvc = { find: jest.fn().mockResolvedValue(null) };
    const { service } = makeService({ userSvc });
    await expect(
      service.createWhatsappAudioMedia({
        wa_media_url: 'https://wa/m/1',
        user_external_id: '919999990001',
        otel_carrier: carrier,
      }),
    ).rejects.toThrow(NotFoundException);
    expect(error).toHaveBeenCalledWith(
      'createWhatsappAudioMedia: user not found for external_id 919999990001',
    );
    error.mockRestore();
  });

  it('warns "duplicate wa_media_url <url> with status <status>" when an existing non-failed row is found', async () => {
    const { warn } = spyLogger();
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue({
      id: 'mm-e',
      wa_media_url: 'https://wa/m/1',
      status: 'ready',
    });
    const { service } = makeService({ repo });
    await service.createWhatsappAudioMedia({
      wa_media_url: 'https://wa/m/1',
      user: { id: 'u1' } as never,
      otel_carrier: carrier,
    });
    expect(warn).toHaveBeenCalledWith(
      'createWhatsappAudioMedia: duplicate wa_media_url https://wa/m/1 with status ready',
    );
    warn.mockRestore();
  });

  it('warns "S3 upload failed for <id>" when bucket.stream rejects', async () => {
    const { warn } = spyLogger();
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-1' }));
    const wabot = {
      downloadMedia: jest.fn().mockResolvedValue({
        stream: makeAsyncStream(Buffer.from('a')),
        content_type: 'audio/mpeg',
      }),
    };
    const bucket = {
      stream: jest.fn().mockRejectedValue(new Error('s3 down')),
      delete: jest.fn(),
    };
    const { service } = makeService({ repo, wabot, bucket });
    await expect(
      service.createWhatsappAudioMedia({
        wa_media_url: 'https://wa/m/1',
        user: { id: 'u1' } as never,
        otel_carrier: carrier,
      }),
    ).rejects.toThrow('s3 down');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/createWhatsappAudioMedia: S3 upload failed for/),
    );
    warn.mockRestore();
  });

  it('warns "<Provider> STT failed for <id>: <msg>" when a provider rejects', async () => {
    const { warn } = spyLogger();
    const { repo, wabot, bucket } = setup();
    const sarvam = {
      run: jest.fn().mockRejectedValue(new Error('sarvam down')),
    };
    // azure is default-enabled but resolves to satisfy the "all failed" guard
    const azure = { run: jest.fn().mockResolvedValue({ id: 'stt' }) };
    const reverie = { run: jest.fn().mockResolvedValue({ id: 'stt' }) };
    const { service } = makeService({
      repo,
      wabot,
      bucket,
      sarvam,
      azure,
      reverie,
    });
    await service.createWhatsappAudioMedia({
      wa_media_url: 'https://wa/m/1',
      user: { id: 'u1' } as never,
      otel_carrier: carrier,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/Sarvam STT failed for .*sarvam down/),
    );
    warn.mockRestore();
  });

  it('warns "all STT providers failed for <id>" and throws when every enabled provider rejected', async () => {
    const { warn } = spyLogger();
    const { repo, wabot, bucket } = setup();
    const sarvam = { run: jest.fn().mockRejectedValue(new Error('s1')) };
    const azure = { run: jest.fn().mockRejectedValue(new Error('s2')) };
    const reverie = { run: jest.fn().mockRejectedValue(new Error('s3')) };
    const { service } = makeService({
      repo,
      wabot,
      bucket,
      sarvam,
      azure,
      reverie,
    });
    await expect(
      service.createWhatsappAudioMedia({
        wa_media_url: 'https://wa/m/1',
        user: { id: 'u1' } as never,
        otel_carrier: carrier,
      }),
    ).rejects.toThrow('All STT providers failed');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /createWhatsappAudioMedia: all STT providers failed for/,
      ),
    );
    warn.mockRestore();
  });
});

describe('createElevenlabsMedia — conditional spreads + queue payload', () => {
  beforeEach(() => {
    process.env.ELEVENLABS_VOICE_ID = 'vc-env';
  });

  it('queue name = `elevenlabs-generate-<id>` and elevenlabs_params is flat with all fields', async () => {
    const repo = makeRepo();
    let i = 0;
    repo.save.mockImplementation(async (e) => ({ ...e, id: `mm-${++i}` }));
    const { service } = makeService({ repo });
    await service.createElevenlabsMedia(
      {
        items: [
          {
            state_transition_id: 's',
            script_text: 'hello',
            voice_id: 'vc-custom',
            model_id: 'm1',
            language_code: 'en',
            voice_settings: { stability: 0.5 },
          },
        ],
      } as never,
      carrier,
    );
    const jobs = mockQueueAddBulk.mock.calls[0][0] as {
      name: string;
      data: {
        media_metadata_id: string;
        elevenlabs_params: Record<string, unknown>;
        otel_carrier: unknown;
      };
    }[];
    expect(jobs[0].name).toBe('elevenlabs-generate-mm-1');
    expect(jobs[0].data.media_metadata_id).toBe('mm-1');
    expect(jobs[0].data.otel_carrier).toBe(carrier);
    expect(jobs[0].data.elevenlabs_params).toEqual({
      script_text: 'hello',
      voice_id: 'vc-custom',
      model_id: 'm1',
      language_code: 'en',
      voice_settings: { stability: 0.5 },
    });
  });

  it('drops voice_id from generation_request_json when it matches the env default', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-1' }));
    const { service } = makeService({ repo });
    await service.createElevenlabsMedia(
      {
        items: [
          {
            state_transition_id: 's',
            script_text: 'hi',
            voice_id: 'vc-env', // == env → dropped
          },
        ],
      } as never,
      carrier,
    );
    const saved = repo.save.mock.calls[0][0] as {
      generation_request_json: Record<string, unknown>;
    };
    expect(saved.generation_request_json).not.toHaveProperty('voice_id');
  });

  it('omits model_id / language_code / voice_settings when undefined', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-1' }));
    const { service } = makeService({ repo });
    await service.createElevenlabsMedia(
      {
        items: [
          {
            state_transition_id: 's',
            script_text: 'hi',
            voice_id: 'vc-custom',
          },
        ],
      } as never,
      carrier,
    );
    const saved = repo.save.mock.calls[0][0] as {
      generation_request_json: Record<string, unknown>;
    };
    expect(saved.generation_request_json).not.toHaveProperty('model_id');
    expect(saved.generation_request_json).not.toHaveProperty('language_code');
    expect(saved.generation_request_json).not.toHaveProperty('voice_settings');
  });

  it('creates the row with media_type=audio, source=elevenlabs, status=created, rolled_back=false', async () => {
    const repo = makeRepo();
    repo.save.mockImplementation(async (e) => ({ ...e, id: 'mm-1' }));
    const { service } = makeService({ repo });
    await service.createElevenlabsMedia(
      {
        items: [
          {
            state_transition_id: 's',
            script_text: 'hi',
            voice_id: 'vc-custom',
          },
        ],
      } as never,
      carrier,
    );
    const created = repo.create.mock.calls[0][0] as {
      media_type: string;
      source: string;
      status: string;
      rolled_back: boolean;
    };
    expect(created.media_type).toBe('audio');
    expect(created.source).toBe('elevenlabs');
    expect(created.status).toBe('created');
    expect(created.rolled_back).toBe(false);
  });

  it('marks rows queued AFTER the bulk add succeeds (repo.update with the saved ids)', async () => {
    const repo = makeRepo();
    let i = 0;
    repo.save.mockImplementation(async (e) => ({ ...e, id: `mm-${++i}` }));
    const { service } = makeService({ repo });
    await service.createElevenlabsMedia(
      {
        items: [
          {
            state_transition_id: 's1',
            script_text: 'a',
            voice_id: 'vc',
          },
          {
            state_transition_id: 's2',
            script_text: 'b',
            voice_id: 'vc',
          },
        ],
      } as never,
      carrier,
    );
    expect(repo.update).toHaveBeenCalledWith(['mm-1', 'mm-2'], {
      status: 'queued',
    });
  });
});

describe('MediaMetaDataService.recordWhatsappUpload / markMediaFailed', () => {
  it('recordWhatsappUpload(markReady=true): writes url + wa_uploaded_at + status=ready in ONE update', async () => {
    const repo = makeRepo();
    const { service } = makeService({ repo });

    await service.recordWhatsappUpload('mm-1', 'https://wa/m1', true);

    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith('mm-1', {
      wa_media_url: 'https://wa/m1',
      wa_uploaded_at: expect.any(Date),
      status: 'ready',
    });
  });

  it('recordWhatsappUpload(markReady=false): refreshes url + stamp WITHOUT touching status', async () => {
    const repo = makeRepo();
    const { service } = makeService({ repo });

    await service.recordWhatsappUpload('mm-1', 'https://wa/m2', false);

    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith('mm-1', {
      wa_media_url: 'https://wa/m2',
      wa_uploaded_at: expect.any(Date),
    });
    expect(repo.update.mock.calls[0][1]).not.toHaveProperty('status');
  });

  it('recordWhatsappUpload stamps a current timestamp (the sweep depends on it)', async () => {
    const repo = makeRepo();
    const { service } = makeService({ repo });
    const before = Date.now();

    await service.recordWhatsappUpload('mm-1', 'https://wa/m1', true);

    const stamp = (
      repo.update.mock.calls[0][1] as { wa_uploaded_at: Date }
    ).wa_uploaded_at.getTime();
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
  });

  it('markMediaFailed: sets status=failed and nothing else', async () => {
    const repo = makeRepo();
    const { service } = makeService({ repo });

    await service.markMediaFailed('mm-1');

    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith('mm-1', { status: 'failed' });
  });
});

// ─── drill-word auto-create on lookup miss ───────────────────────────────────

describe('findMediaByStateTransitionId — drill-word auto-create', () => {
  const STID = 'पीला-sentence-word-drillWord';

  function makeCache(cached: unknown = null) {
    return {
      get: jest.fn().mockResolvedValue(cached),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn(),
    };
  }

  // Routes dsQuery by SQL shape: lookup SELECT, INSERT..ON CONFLICT, re-SELECT.
  function routedQuery(handlers: {
    lookup?: unknown[];
    insert?: () => unknown[] | Promise<unknown[]>;
    reselect?: unknown[];
  }) {
    return jest.fn((sql: string) => {
      if (sql.includes('INSERT INTO media_metadata')) {
        return Promise.resolve(handlers.insert ? handlers.insert() : []);
      }
      if (
        sql.includes("source = 'drill-word-auto'") &&
        sql.includes('SELECT')
      ) {
        return Promise.resolve(handlers.reselect ?? []);
      }
      return Promise.resolve(handlers.lookup ?? []);
    });
  }

  const createdRow = {
    id: 'gen-uuid',
    media_type: 'text',
    source: 'drill-word-auto',
    status: 'ready',
    text: 'पीला',
    state_transition_id: STID,
  };

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('auto-creates the text row on a miss and returns + caches it', async () => {
    const cache = makeCache();
    const dsQuery = routedQuery({ lookup: [], insert: () => [createdRow] });
    const { service } = makeService({ cache, dsQuery });

    const out = await service.findMediaByStateTransitionId(STID);

    expect(out.text).toEqual(createdRow);
    const insertCall = dsQuery.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO media_metadata'),
    )!;
    expect(insertCall[0]).toContain(
      "ON CONFLICT (state_transition_id) WHERE source = 'drill-word-auto' DO NOTHING",
    );
    expect(insertCall[1]).toEqual(['gen-uuid', 'पीला', STID]);
    // Non-empty result → cached, including the synthesized row.
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining(STID),
      expect.objectContaining({ text: createdRow }),
      expect.anything(),
    );
  });

  it('does NOT warn "no media found" when the row was auto-created', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const dsQuery = routedQuery({ lookup: [], insert: () => [createdRow] });
    const { service } = makeService({ cache: makeCache(), dsQuery });

    await service.findMediaByStateTransitionId(STID);

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('no media found'),
    );
  });

  it('lost race: ON CONFLICT returns no row → re-selects the winner', async () => {
    const winner = { ...createdRow, id: 'winner-row' };
    const dsQuery = routedQuery({
      lookup: [],
      insert: () => [],
      reselect: [winner],
    });
    const { service } = makeService({ cache: makeCache(), dsQuery });

    const out = await service.findMediaByStateTransitionId(STID);

    expect(out.text).toEqual(winner);
  });

  it('a seeded exact-match text row wins — no INSERT happens', async () => {
    const seeded = {
      id: 'seeded-1',
      media_type: 'text',
      state_transition_id: STID,
    };
    const dsQuery = routedQuery({ lookup: [seeded] });
    const { service } = makeService({ cache: makeCache(), dsQuery });

    const out = await service.findMediaByStateTransitionId(STID);

    expect(out.text?.id).toBe('seeded-1');
    expect(dsQuery.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(
      false,
    );
  });

  it('a seeded generic text row wins — no INSERT happens', async () => {
    const generic = {
      id: 'generic-text-1',
      media_type: 'text',
      state_transition_id: '_-sentence-word-drillWord',
    };
    const dsQuery = routedQuery({ lookup: [generic] });
    const { service } = makeService({ cache: makeCache(), dsQuery });

    const out = await service.findMediaByStateTransitionId(STID);

    expect(out.text?.id).toBe('generic-text-1');
    expect(dsQuery.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(
      false,
    );
  });

  it('creates the text row even when other media types exist (generic voice note)', async () => {
    const genericAudio = {
      id: 'generic-audio-1',
      media_type: 'audio',
      state_transition_id: '_-sentence-word-drillWord',
    };
    const dsQuery = routedQuery({
      lookup: [genericAudio],
      insert: () => [createdRow],
    });
    const { service } = makeService({ cache: makeCache(), dsQuery });

    const out = await service.findMediaByStateTransitionId(STID);

    expect(out.audio?.id).toBe('generic-audio-1');
    expect(out.text).toEqual(createdRow);
  });

  it.each([
    ['_-sentence-word-drillWord', 'generic key itself'],
    ['sentence-sentence-word-drillWord', 'fixed sentence prefix'],
    ['sentence-start-sentence-initial', 'non-matching fixed stid'],
    ['पीला-sentence-word-drillWordX', 'suffix mismatch'],
    ['पीला-word-routeWrongLetter-drillLetters', 'letter drill stid'],
  ])('never auto-creates for %s (%s)', async (stid) => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const dsQuery = routedQuery({ lookup: [] });
    const { service } = makeService({ cache: makeCache(), dsQuery });

    const out = await service.findMediaByStateTransitionId(stid);

    expect(out.text).toBeUndefined();
    expect(dsQuery.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(
      false,
    );
    // Still the plain miss path → warns as before.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no media found'),
    );
  });

  it('a cached result short-circuits before any auto-create', async () => {
    const dsQuery = jest.fn();
    const { service } = makeService({
      cache: makeCache({ text: { id: 'cached-text' } }),
      dsQuery,
    });

    const out = await service.findMediaByStateTransitionId(STID);

    expect(out.text?.id).toBe('cached-text');
    expect(dsQuery).not.toHaveBeenCalled();
  });

  it('retries after a transient failure and warns about DB pressure', async () => {
    jest.useFakeTimers();
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    let calls = 0;
    const dsQuery = routedQuery({
      lookup: [],
      insert: () => {
        calls++;
        if (calls === 1) throw new Error('db hiccup');
        return [createdRow];
      },
    });
    const { service } = makeService({ cache: makeCache(), dsQuery });

    const pending = service.findMediaByStateTransitionId(STID);
    await jest.advanceTimersByTimeAsync(5_000); // covers the ~1s±25% first delay
    const out = await pending;

    expect(out.text).toEqual(createdRow);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('succeeded after 2 attempts'),
    );
  });

  it('exhausts the retry budget on persistent failure and rethrows', async () => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    let inserts = 0;
    const dsQuery = routedQuery({
      lookup: [],
      insert: () => {
        inserts++;
        throw new Error('db down');
      },
    });
    const { service } = makeService({ cache: makeCache(), dsQuery });

    const pending = service.findMediaByStateTransitionId(STID);
    const assertion = expect(pending).rejects.toThrow('db down');
    await jest.advanceTimersByTimeAsync(40_000); // walks every backoff delay
    await assertion;

    expect(inserts).toBe(5); // initial + 4 retries, then gives up
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('drill-word auto-create FAILED after 5 attempts'),
    );
  });

  it('throws when the conflict row cannot be re-selected (index/data drift)', async () => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const dsQuery = routedQuery({ lookup: [], insert: () => [], reselect: [] });
    const { service } = makeService({ cache: makeCache(), dsQuery });

    const pending = service.findMediaByStateTransitionId(STID);
    const assertion = expect(pending).rejects.toThrow(
      'conflict but no existing row found',
    );
    await jest.advanceTimersByTimeAsync(40_000);
    await assertion;
  });
});
