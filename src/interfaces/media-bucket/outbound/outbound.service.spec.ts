jest.mock('uuid', () => ({ v4: jest.fn(() => 'gen-key') }));

const mockSend = jest.fn();
const mockS3ClientCtor = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation((cfg) => {
    mockS3ClientCtor(cfg);
    return { send: mockSend };
  }),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({
    __cmd: 'Put',
    input,
  })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({
    __cmd: 'Get',
    input,
  })),
  DeleteObjectCommand: jest.fn().mockImplementation((input) => ({
    __cmd: 'Delete',
    input,
  })),
}));

process.env.MEDIA_BUCKET_NAME = 'test-bucket';
process.env.MEDIA_BUCKET_ENDPOINT = 'https://s3.test';
process.env.MEDIA_BUCKET_ACCESS_KEY = 'access';
process.env.MEDIA_BUCKET_SECRET_KEY = 'secret';

import { Readable } from 'stream';
import { MediaBucketService } from './outbound.service';

// Async iterable that yields the literal values given (no coercion).
// Used to exercise the non-Buffer branch in the chunk-loop ternaries.
function rawIterable<T>(values: T[]): AsyncIterable<T> & NodeJS.ReadableStream {
  const iter: AsyncIterable<T> = {
    async *[Symbol.asyncIterator]() {
      for (const v of values) yield v;
    },
  };
  return iter as AsyncIterable<T> & NodeJS.ReadableStream;
}

beforeEach(() => {
  mockSend.mockReset();
  mockS3ClientCtor.mockClear();
});

describe('MediaBucketService — constructor', () => {
  it('passes env config to the S3Client with region default "auto" and forcePathStyle:true', async () => {
    const prevRegion = process.env.MEDIA_BUCKET_REGION;
    delete process.env.MEDIA_BUCKET_REGION;

    new MediaBucketService();

    expect(mockS3ClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://s3.test',
        region: 'auto',
        credentials: { accessKeyId: 'access', secretAccessKey: 'secret' },
        forcePathStyle: true,
      }),
    );

    if (prevRegion !== undefined) process.env.MEDIA_BUCKET_REGION = prevRegion;
  });

  it('uses MEDIA_BUCKET_REGION when set', async () => {
    process.env.MEDIA_BUCKET_REGION = 'us-east-2';
    new MediaBucketService();
    expect(mockS3ClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-east-2' }),
    );
    delete process.env.MEDIA_BUCKET_REGION;
  });
});

describe('MediaBucketService.stream', () => {
  it('collects readable chunks, PUTs to S3, returns generated key', async () => {
    mockSend.mockResolvedValue(undefined);
    const svc = new MediaBucketService();
    const stream = Readable.from([Buffer.from('he'), Buffer.from('llo')]);

    const key = await svc.stream(stream, 'audio/mpeg');

    expect(key).toBe('gen-key');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0] as { __cmd: string; input: any };
    expect(cmd.__cmd).toBe('Put');
    expect(cmd.input).toEqual({
      Bucket: 'test-bucket',
      Key: 'gen-key',
      Body: Buffer.from('hello'),
      ContentLength: 5,
      ContentType: 'audio/mpeg',
    });
  });

  it('converts non-Buffer chunks (strings) to Buffers before upload', async () => {
    mockSend.mockResolvedValue(undefined);
    const svc = new MediaBucketService();
    const stream = rawIterable(['ab', 'cd']);

    const key = await svc.stream(stream, 'text/plain');

    expect(key).toBe('gen-key');
    const cmd = mockSend.mock.calls[0][0] as { input: { Body: Buffer } };
    expect(Buffer.isBuffer(cmd.input.Body)).toBe(true);
    expect(cmd.input.Body.toString()).toBe('abcd');
  });

  it('rethrows when s3.send rejects (and logs)', async () => {
    mockSend.mockRejectedValue(new Error('s3 down'));
    const svc = new MediaBucketService();
    await expect(
      svc.stream(Readable.from([Buffer.from('x')]), 'audio/mpeg'),
    ).rejects.toThrow('s3 down');
  });

  it('handles an empty readable (ContentLength=0, empty body)', async () => {
    mockSend.mockResolvedValue(undefined);
    const svc = new MediaBucketService();

    const key = await svc.stream(Readable.from([]), 'application/octet-stream');

    expect(key).toBe('gen-key');
    const cmd = mockSend.mock.calls[0][0] as { input: { ContentLength: number; Body: Buffer } };
    expect(cmd.input.ContentLength).toBe(0);
    expect(cmd.input.Body.length).toBe(0);
  });
});

describe('MediaBucketService.getBuffer', () => {
  it('streams response.Body, returns {buffer, content_type} from S3 response', async () => {
    const body = Readable.from([Buffer.from('ab'), Buffer.from('cd')]);
    mockSend.mockResolvedValue({ Body: body, ContentType: 'audio/mpeg' });
    const svc = new MediaBucketService();

    const out = await svc.getBuffer('s3-key-1');

    expect(out.buffer.toString()).toBe('abcd');
    expect(out.content_type).toBe('audio/mpeg');
    const cmd = mockSend.mock.calls[0][0] as { __cmd: string; input: any };
    expect(cmd.__cmd).toBe('Get');
    expect(cmd.input).toEqual({ Bucket: 'test-bucket', Key: 's3-key-1' });
  });

  it('defaults content_type to application/octet-stream when missing', async () => {
    const body = Readable.from([Buffer.from('x')]);
    mockSend.mockResolvedValue({ Body: body });
    const svc = new MediaBucketService();

    const out = await svc.getBuffer('s3-key-1');
    expect(out.content_type).toBe('application/octet-stream');
  });

  it('converts non-Buffer chunks (strings) to Buffers', async () => {
    const body = rawIterable(['ab', 'cd']);
    mockSend.mockResolvedValue({ Body: body });
    const svc = new MediaBucketService();

    const out = await svc.getBuffer('s3-key-1');
    expect(Buffer.isBuffer(out.buffer)).toBe(true);
    expect(out.buffer.toString()).toBe('abcd');
  });

  it('rethrows when s3.send rejects (and logs)', async () => {
    mockSend.mockRejectedValue(new Error('NoSuchKey'));
    const svc = new MediaBucketService();
    await expect(svc.getBuffer('missing')).rejects.toThrow('NoSuchKey');
  });

  it('handles an empty S3 body stream (returns empty buffer)', async () => {
    mockSend.mockResolvedValue({ Body: Readable.from([]), ContentType: 'audio/mpeg' });
    const svc = new MediaBucketService();
    const out = await svc.getBuffer('s3-key-1');
    expect(out.buffer.length).toBe(0);
  });
});

describe('MediaBucketService.delete', () => {
  it('sends DeleteObjectCommand with bucket + key', async () => {
    mockSend.mockResolvedValue(undefined);
    const svc = new MediaBucketService();

    await svc.delete('s3-key-1');

    const cmd = mockSend.mock.calls[0][0] as { __cmd: string; input: any };
    expect(cmd.__cmd).toBe('Delete');
    expect(cmd.input).toEqual({ Bucket: 'test-bucket', Key: 's3-key-1' });
  });

  it('rethrows when s3.send rejects (and logs)', async () => {
    mockSend.mockRejectedValue(new Error('AccessDenied'));
    const svc = new MediaBucketService();
    await expect(svc.delete('s3-key-1')).rejects.toThrow('AccessDenied');
  });
});
