// uuid is ESM-only; the controller imports it directly via v4 as uuid.
jest.mock('uuid', () => ({ v4: jest.fn(() => 'generated-uuid') }));

// Prevent the transitive Redis socket open at queues.ts module load when
// MediaMetaDataService is imported (controller has a type-only ref via DI).
jest.mock('../interfaces/redis/queues', () => ({
  createQueue: jest.fn(() => ({ add: jest.fn(), addBulk: jest.fn() })),
  QUEUE_NAMES: {
    HEYGEN_GENERATE: 'heygen-generate',
    ELEVENLABS_GENERATE: 'elevenlabs-generate',
    WHATSAPP_PRELOAD: 'whatsapp-preload',
  },
}));

const mockSpanEnd = jest.fn();
const mockStartRootSpan = jest.fn(() => ({ end: mockSpanEnd }));
const mockInjectCarrier = jest.fn(() => ({ traceparent: 'tp' }));
jest.mock('../otel/otel', () => ({
  startRootSpan: (...args: unknown[]) => mockStartRootSpan(...args),
  injectCarrier: (...args: unknown[]) => mockInjectCarrier(...args),
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { MediaMetaDataController } from './media-meta-data.controller';
import type { MediaMetaDataService } from './media-meta-data.service';
import type { MediaMetadataCoverageService } from './media-metadata-coverage.service';
import type { MediaBucketService } from '../interfaces/media-bucket/outbound/outbound.service';
import type { MediaMetaDataEntity } from './media-meta-data.entity';

type RepoMock = {
  find: jest.Mock;
  findOneBy: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
};

function makeRepo(): RepoMock {
  return {
    find: jest.fn(),
    findOneBy: jest.fn(),
    create: jest.fn((row) => ({ ...row })),
    save: jest.fn(),
    remove: jest.fn(),
  };
}

function makeController(opts: {
  mediaSvc?: Partial<MediaMetaDataService>;
  coverageSvc?: Partial<MediaMetadataCoverageService>;
  bucket?: Partial<MediaBucketService>;
  repo?: RepoMock;
}): { ctrl: MediaMetaDataController; repo: RepoMock } {
  const repo = opts.repo ?? makeRepo();
  return {
    ctrl: new MediaMetaDataController(
      (opts.mediaSvc ?? {}) as MediaMetaDataService,
      (opts.coverageSvc ?? {}) as MediaMetadataCoverageService,
      (opts.bucket ?? {}) as MediaBucketService,
      repo as unknown as Repository<MediaMetaDataEntity>,
    ),
    repo,
  };
}

function makeRes() {
  const res: any = {
    set: jest.fn(),
    send: jest.fn(),
  };
  res.set.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  mockSpanEnd.mockReset();
  mockStartRootSpan.mockClear();
  mockInjectCarrier.mockClear();
});

describe('MediaMetaDataController.getCoverage', () => {
  it('delegates to MediaMetadataCoverageService.getCoverage', async () => {
    const getCoverage = jest.fn().mockResolvedValue({ rows: [] });
    const { ctrl } = makeController({ coverageSvc: { getCoverage } });
    await expect(ctrl.getCoverage()).resolves.toEqual({ rows: [] });
  });
});

describe('MediaMetaDataController.listByStateTransitionId', () => {
  it('throws BadRequest when stid is empty', async () => {
    const { ctrl } = makeController({});
    await expect(ctrl.listByStateTransitionId('')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('throws BadRequest when stid is not a string', async () => {
    const { ctrl } = makeController({});
    await expect(
      ctrl.listByStateTransitionId(null as unknown as string),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns the mapped media items shape', async () => {
    const rows = [
      {
        id: 'mm-1',
        media_type: 'audio',
        source: 'heygen',
        status: 'ready',
        created_at: new Date('2026-04-27T10:00:00Z'),
        state_transition_id: 'क-letter-word-correct-last',
        text: null,
        s3_key: 's3-1',
        wa_media_url: 'https://wabot/m/1',
        media_details: { mime_type: 'audio/mpeg' },
        generation_request_json: { script_text: 'hi' },
      },
    ];
    const repo = makeRepo();
    repo.find.mockResolvedValue(rows);

    const { ctrl } = makeController({ repo });
    const out = await ctrl.listByStateTransitionId(
      'क-letter-word-correct-last',
    );

    expect(out).toEqual([
      {
        id: 'mm-1',
        media_type: 'audio',
        source: 'heygen',
        status: 'ready',
        created_at: rows[0].created_at,
        state_transition_id: 'क-letter-word-correct-last',
        text: null,
        has_content: true,
        content_mime: 'audio/mpeg',
        generation_script: 'hi',
        wa_media_url: 'https://wabot/m/1',
      },
    ]);
  });

  it('returns null fields when generation_request_json and media_details are null', async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValue([
      {
        id: 'mm-1',
        media_type: 'text',
        source: 'whatsapp',
        status: 'ready',
        created_at: new Date(),
        state_transition_id: 'stid',
        text: 'hello',
        s3_key: null,
        wa_media_url: null,
        media_details: null,
        generation_request_json: null,
      },
    ]);
    const { ctrl } = makeController({ repo });

    const out = await ctrl.listByStateTransitionId('stid');
    expect(out[0]).toMatchObject({
      text: 'hello',
      has_content: false,
      content_mime: null,
      generation_script: null,
    });
  });
});

describe('MediaMetaDataController.deleteMedia', () => {
  it('delegates to MediaMetaDataService.markRolledBack', async () => {
    const markRolledBack = jest.fn().mockResolvedValue(undefined);
    const { ctrl } = makeController({ mediaSvc: { markRolledBack } });

    await expect(ctrl.deleteMedia('mm-1')).resolves.toEqual({ deleted: true });
    expect(markRolledBack).toHaveBeenCalledWith('mm-1');
  });
});

describe('MediaMetaDataController.getAudio', () => {
  it('throws NotFoundException when media row is missing', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    const { ctrl } = makeController({ repo });

    await expect(ctrl.getAudio('mm-1', makeRes())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException when media row has no s3_key', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue({ id: 'mm-1', s3_key: null });
    const { ctrl } = makeController({ repo });

    await expect(ctrl.getAudio('mm-1', makeRes())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns the S3 buffer with Content-Type and Content-Length headers', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue({ id: 'mm-1', s3_key: 's3-1' });
    const getBuffer = jest.fn().mockResolvedValue({
      buffer: Buffer.from('abc'),
      content_type: 'audio/mpeg',
    });
    const bucket = { getBuffer } as unknown as MediaBucketService;
    const { ctrl } = makeController({ repo, bucket });
    const res = makeRes();

    await ctrl.getAudio('mm-1', res);

    expect(res.set).toHaveBeenCalledWith('Content-Type', 'audio/mpeg');
    expect(res.set).toHaveBeenCalledWith('Content-Length', '3');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('abc'));
  });
});

describe('MediaMetaDataController.generateHeygenMedia', () => {
  it('delegates to service, returns count + entities, ends span', async () => {
    const entities = [{ id: 'mm-1' }];
    const createHeygenMedia = jest.fn().mockResolvedValue(entities);
    const { ctrl } = makeController({
      mediaSvc: { createHeygenMedia },
    });

    const out = await ctrl.generateHeygenMedia({
      items: [
        {
          state_transition_id: 'क-letter-word-correct-last',
          media_type: 'video',
          script_text: 'hi',
        },
      ],
    });

    expect(out).toEqual({ created: 1, entities });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid body (missing items)', async () => {
    const { ctrl } = makeController({});
    await expect(ctrl.generateHeygenMedia({})).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('MediaMetaDataController.generateElevenlabsMedia', () => {
  it('delegates to service and ends span', async () => {
    const entities = [{ id: 'mm-1' }];
    const createElevenlabsMedia = jest.fn().mockResolvedValue(entities);
    const { ctrl } = makeController({
      mediaSvc: { createElevenlabsMedia },
    });

    const out = await ctrl.generateElevenlabsMedia({
      items: [
        {
          state_transition_id: 'क-letter-word-correct-last',
          script_text: 'hi',
        },
      ],
    });

    expect(out).toEqual({ created: 1, entities });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });
});

describe('MediaMetaDataController.uploadStaticMedia', () => {
  it('rejects malformed JSON in items field', async () => {
    const { ctrl } = makeController({});
    await expect(
      ctrl.uploadStaticMedia([] as never, { items: 'not-json' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects when file count != non-text item count', async () => {
    const { ctrl } = makeController({});

    await expect(
      ctrl.uploadStaticMedia([] as never, {
        items: JSON.stringify([
          { state_transition_id: 'stid-1', media_type: 'image' },
        ]),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('delegates to service when items and files match', async () => {
    const uploadStaticMedia = jest.fn().mockResolvedValue({
      results: [],
      summary: { created: 0, duplicate_skipped: 0, failed: 0 },
    });
    const { ctrl } = makeController({
      mediaSvc: { uploadStaticMedia },
    });

    const files = [
      {
        buffer: Buffer.from('img'),
        mimetype: 'image/jpeg',
        size: 3,
        originalname: 'a.jpg',
      },
    ] as Express.Multer.File[];

    const out = await ctrl.uploadStaticMedia(files, {
      items: JSON.stringify([
        { state_transition_id: 'stid-1', media_type: 'image' },
      ]),
    });

    expect(uploadStaticMedia).toHaveBeenCalled();
    expect(out.summary).toBeDefined();
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('accepts items already in parsed-array form (not stringified)', async () => {
    const uploadStaticMedia = jest.fn().mockResolvedValue({
      results: [],
      summary: { created: 0, duplicate_skipped: 0, failed: 0 },
    });
    const { ctrl } = makeController({
      mediaSvc: { uploadStaticMedia },
    });

    await ctrl.uploadStaticMedia([], {
      items: [
        { state_transition_id: 'stid-1', media_type: 'text', text: 'hi' },
      ],
    });

    expect(uploadStaticMedia).toHaveBeenCalled();
  });
});

describe('MediaMetaDataController.createDashboardTranscript', () => {
  it('rejects when text is missing or whitespace', async () => {
    const { ctrl } = makeController({});
    await expect(
      ctrl.createDashboardTranscript('mm-1', { text: '   ' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException when parent media row is missing', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    const { ctrl } = makeController({ repo });

    await expect(
      ctrl.createDashboardTranscript('mm-1', { text: 'hi' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequest when a dashboard transcript already exists', async () => {
    const repo = makeRepo();
    repo.findOneBy
      .mockResolvedValueOnce({ id: 'mm-1', user_id: 'u1' }) // parent
      .mockResolvedValueOnce({ id: 'mm-2' }); // existing dashboard transcript
    const { ctrl } = makeController({ repo });

    await expect(
      ctrl.createDashboardTranscript('mm-1', { text: 'hi' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('creates and returns the transcript response', async () => {
    const repo = makeRepo();
    repo.findOneBy
      .mockResolvedValueOnce({ id: 'mm-1', user_id: 'u1' })
      .mockResolvedValueOnce(null);
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date('2026-04-27T10:00:00Z'),
    }));

    const { ctrl } = makeController({ repo });
    const out = await ctrl.createDashboardTranscript('mm-1', {
      text: '  hello  ',
    });

    expect(out.text).toBe('hello'); // trimmed
    expect(out.input_media_id).toBe('mm-1');
    expect(out.user_id).toBe('u1');
    expect(out.source).toBe('dashboard');
  });
});

describe('MediaMetaDataController.updateDashboardTranscript', () => {
  it('rejects when text is missing or whitespace', async () => {
    const { ctrl } = makeController({});
    await expect(
      ctrl.updateDashboardTranscript('mm-1', { text: '' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException when the transcript is missing', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    const { ctrl } = makeController({ repo });

    await expect(
      ctrl.updateDashboardTranscript('mm-1', { text: 'hi' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('trims and saves the new text', async () => {
    const repo = makeRepo();
    const transcript = {
      id: 'mm-2',
      text: 'old',
      source: 'dashboard',
      input_media_id: 'mm-1',
      user_id: 'u1',
      created_at: new Date(),
    };
    repo.findOneBy.mockResolvedValue(transcript);
    repo.save.mockImplementation(async (e) => e);
    const { ctrl } = makeController({ repo });

    const out = await ctrl.updateDashboardTranscript('mm-1', {
      text: '  new  ',
    });

    expect(out.text).toBe('new');
  });
});

describe('MediaMetaDataController.deleteDashboardTranscript', () => {
  it('throws NotFoundException when the transcript is missing', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    const { ctrl } = makeController({ repo });

    await expect(ctrl.deleteDashboardTranscript('mm-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('removes the transcript and returns {deleted: true}', async () => {
    const repo = makeRepo();
    const transcript = { id: 'mm-2' };
    repo.findOneBy.mockResolvedValue(transcript);
    repo.remove.mockResolvedValue(undefined);
    const { ctrl } = makeController({ repo });

    await expect(ctrl.deleteDashboardTranscript('mm-1')).resolves.toEqual({
      deleted: true,
    });
    expect(repo.remove).toHaveBeenCalledWith(transcript);
  });
});

// ─── mutation hardening ────────────────────────────────────────────────────

describe('MediaMetaDataController — exact error messages + find shapes', () => {
  it('listByStateTransitionId BadRequest message is exact', async () => {
    const { ctrl } = makeController({});
    await expect(ctrl.listByStateTransitionId('')).rejects.toThrow(
      'state_transition_id query param required',
    );
  });

  it('listByStateTransitionId find() is { where: { state_transition_id, rolled_back: false }, order: { created_at: "ASC" } }', async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValue([]);
    const { ctrl } = makeController({ repo });
    await ctrl.listByStateTransitionId('stid-1');
    expect(repo.find).toHaveBeenCalledWith({
      where: { state_transition_id: 'stid-1', rolled_back: false },
      order: { created_at: 'ASC' },
    });
  });

  it('getAudio NotFound message is exact when row is missing', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    const { ctrl } = makeController({ repo });
    await expect(
      ctrl.getAudio('mm-1', { set: jest.fn(), send: jest.fn() } as never),
    ).rejects.toThrow('Media not found or no audio available');
  });

  it('uploadStaticMedia: malformed JSON throws "items must be valid JSON" exactly', async () => {
    const { ctrl } = makeController({});
    await expect(
      ctrl.uploadStaticMedia([], { items: '{bad' } as never),
    ).rejects.toThrow('items must be valid JSON');
  });

  it('uploadStaticMedia: file/non-text-count mismatch error format includes both counts', async () => {
    const { ctrl } = makeController({});
    await expect(
      ctrl.uploadStaticMedia(
        [], // 0 files
        {
          items: JSON.stringify([
            { state_transition_id: 's', media_type: 'image' },
          ]),
        } as never,
      ),
    ).rejects.toThrow(
      'files length (0) must equal number of non-text items (1)',
    );
  });

  it('starts a root span named "heygen-generate-controller" and ends it', async () => {
    const mediaSvc = {
      createHeygenMedia: jest.fn().mockResolvedValue([{ id: 'm1' }]),
    } as Partial<MediaMetaDataService>;
    const { ctrl } = makeController({ mediaSvc });
    await ctrl.generateHeygenMedia({
      items: [
        {
          state_transition_id: 's',
          media_type: 'video',
          script_text: 'x',
          avatar_id: 'av',
          voice_id: 'vc',
        },
      ],
    } as never);
    expect(mockStartRootSpan).toHaveBeenCalledWith(
      'heygen-generate-controller',
    );
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('starts a root span named "elevenlabs-generate-controller" and ends it', async () => {
    const mediaSvc = {
      createElevenlabsMedia: jest.fn().mockResolvedValue([{ id: 'm1' }]),
    } as Partial<MediaMetaDataService>;
    const { ctrl } = makeController({ mediaSvc });
    await ctrl.generateElevenlabsMedia({
      items: [
        {
          state_transition_id: 's',
          script_text: 'x',
          voice_id: 'vc',
        },
      ],
    } as never);
    expect(mockStartRootSpan).toHaveBeenCalledWith(
      'elevenlabs-generate-controller',
    );
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('starts a root span named "upload-static-controller" and ends it', async () => {
    const mediaSvc = {
      uploadStaticMedia: jest
        .fn()
        .mockResolvedValue({ results: [], summary: {} }),
    } as Partial<MediaMetaDataService>;
    const { ctrl } = makeController({ mediaSvc });
    await ctrl.uploadStaticMedia([], {
      items: JSON.stringify([
        {
          state_transition_id: 's',
          media_type: 'text',
          text: 'hi',
        },
      ]),
    } as never);
    expect(mockStartRootSpan).toHaveBeenCalledWith('upload-static-controller');
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('createDashboardTranscript: rejects missing text with exact "text required"', async () => {
    const { ctrl } = makeController({});
    await expect(
      ctrl.createDashboardTranscript('mm-1', { text: '   ' } as never),
    ).rejects.toThrow('text required');
  });

  it('createDashboardTranscript: rejects when parent media row is missing with exact "Media not found"', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    const { ctrl } = makeController({ repo });
    await expect(
      ctrl.createDashboardTranscript('mm-1', { text: 'hi' } as never),
    ).rejects.toThrow('Media not found');
  });

  it('createDashboardTranscript: duplicate-check findOneBy({ input_media_id, source: "dashboard", media_type: "text" })', async () => {
    const repo = makeRepo();
    repo.findOneBy
      .mockResolvedValueOnce({ id: 'mm-1', user_id: 'u1' }) // parent
      .mockResolvedValueOnce(null); // no dup
    repo.save.mockImplementation(async (e) => ({
      ...e,
      created_at: new Date(),
    }));
    const { ctrl } = makeController({ repo });
    await ctrl.createDashboardTranscript('mm-1', {
      text: '  hello  ',
    } as never);
    expect(repo.findOneBy.mock.calls[1][0]).toEqual({
      input_media_id: 'mm-1',
      source: 'dashboard',
      media_type: 'text',
    });
    // Saved row uses TRIMMED text + media_type=text + source=dashboard + status=ready + rolled_back=false
    const created = repo.create.mock.calls[0][0] as {
      text: string;
      media_type: string;
      source: string;
      status: string;
      rolled_back: boolean;
      input_media_id: string;
      user_id: string;
    };
    expect(created.text).toBe('hello');
    expect(created.media_type).toBe('text');
    expect(created.source).toBe('dashboard');
    expect(created.status).toBe('ready');
    expect(created.rolled_back).toBe(false);
    expect(created.input_media_id).toBe('mm-1');
    expect(created.user_id).toBe('u1');
  });

  it('createDashboardTranscript: duplicate-found message is "Dashboard transcript already exists"', async () => {
    const repo = makeRepo();
    repo.findOneBy
      .mockResolvedValueOnce({ id: 'mm-1', user_id: 'u1' })
      .mockResolvedValueOnce({ id: 'existing-1' });
    const { ctrl } = makeController({ repo });
    await expect(
      ctrl.createDashboardTranscript('mm-1', { text: 'x' } as never),
    ).rejects.toThrow('Dashboard transcript already exists');
  });

  it('updateDashboardTranscript: missing-text and missing-transcript messages are exact + lookup shape', async () => {
    const { ctrl: c1 } = makeController({});
    await expect(
      c1.updateDashboardTranscript('mm-1', { text: '\t\n' } as never),
    ).rejects.toThrow('text required');

    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    const { ctrl: c2 } = makeController({ repo });
    await expect(
      c2.updateDashboardTranscript('mm-1', { text: 'hi' } as never),
    ).rejects.toThrow('Dashboard transcript not found');
    expect(repo.findOneBy).toHaveBeenCalledWith({
      input_media_id: 'mm-1',
      source: 'dashboard',
      media_type: 'text',
    });
  });

  it('updateDashboardTranscript: trims the new text before save', async () => {
    const transcript = {
      id: 'mm-t',
      text: 'old',
      source: 'dashboard',
      input_media_id: 'mm-1',
      user_id: 'u1',
      created_at: new Date(),
    };
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(transcript);
    repo.save.mockImplementation(async (e) => e);
    const { ctrl } = makeController({ repo });
    await ctrl.updateDashboardTranscript('mm-1', {
      text: '   new value   ',
    } as never);
    expect(transcript.text).toBe('new value');
  });

  it('deleteDashboardTranscript: lookup uses the same { input_media_id, source: "dashboard", media_type: "text" } shape; missing throws exact message', async () => {
    const repo = makeRepo();
    repo.findOneBy.mockResolvedValue(null);
    const { ctrl } = makeController({ repo });
    await expect(ctrl.deleteDashboardTranscript('mm-1')).rejects.toThrow(
      'Dashboard transcript not found',
    );
    expect(repo.findOneBy).toHaveBeenCalledWith({
      input_media_id: 'mm-1',
      source: 'dashboard',
      media_type: 'text',
    });
  });
});
