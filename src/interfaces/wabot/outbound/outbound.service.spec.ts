process.env.LOG_PII_HMAC_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';
process.env.WABOT_INTERNAL_BASE_URL = 'https://wabot.test/api';
process.env.WABOT_API_KEY = 'test-api-key';

const mockSpanEnd = jest.fn();
const mockSpanSetAttribute = jest.fn();
const mockSpanSetStatus = jest.fn();
const mockSpanRecordException = jest.fn();
jest.mock('../../../otel/otel', () => ({
  tracer: {
    startActiveSpan: jest.fn(async (_name: string, cb: any) =>
      cb({
        setAttribute: mockSpanSetAttribute,
        setStatus: mockSpanSetStatus,
        recordException: mockSpanRecordException,
        end: mockSpanEnd,
      }),
    ),
  },
}));

import { WabotOutboundService } from './outbound.service';
import type { OutboundMediaItem } from './outbound.dto';

function fakeResponse(opts: {
  status?: number;
  json?: unknown;
  text?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Response {
  const status = opts.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    body: opts.body ?? null,
    headers: {
      get: (k: string) => opts.headers?.[k.toLowerCase()] ?? null,
    },
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? '',
  } as unknown as Response;
}

const globalFetch = global.fetch;

beforeEach(() => {
  mockSpanEnd.mockReset();
  mockSpanSetAttribute.mockReset();
  mockSpanSetStatus.mockReset();
  mockSpanRecordException.mockReset();
});

afterEach(() => {
  global.fetch = globalFetch;
});

const baseMedia: OutboundMediaItem[] = [
  { type: 'video', url: 'https://cdn/v.mp4' },
];
const carrier = { traceparent: 'tp' } as never;

describe('WabotOutboundService.sendMessage', () => {
  it('POSTs to /sendMessage with the expected body and returns {status, body}', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({ status: 200, json: { delivered: true } }),
    );
    const svc = new WabotOutboundService();

    const out = await svc.sendMessage({
      user_external_id: '919999990001',
      wamid: 'wamid.X',
      consecutive: true,
      media: baseMedia,
      otel_carrier: carrier,
    });

    expect(out).toEqual({ status: 200, body: { delivered: true } });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://wabot.test/api/sendMessage');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-api-key');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual({
      user_external_id: '919999990001',
      wamid: 'wamid.X',
      consecutive: true,
      media: baseMedia,
      otel: { carrier },
    });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('rethrows + records exception when fetch itself throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('netfail'));
    const svc = new WabotOutboundService();

    await expect(
      svc.sendMessage({
        user_external_id: '919999990001',
        wamid: 'wamid.X',
        media: baseMedia,
        otel_carrier: carrier,
      }),
    ).rejects.toThrow('netfail');

    expect(mockSpanRecordException).toHaveBeenCalled();
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('rethrows when json() parsing rejects (post-fetch)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new Error('bad json');
      },
    } as unknown as Response);
    const svc = new WabotOutboundService();

    await expect(
      svc.sendMessage({
        user_external_id: '919999990001',
        wamid: 'wamid.X',
        media: baseMedia,
        otel_carrier: carrier,
      }),
    ).rejects.toThrow('bad json');
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });
});

describe('WabotOutboundService.sendNotification', () => {
  it('POSTs to /sendNotification with the expected body and returns the parsed JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({ status: 200, json: { delivered: true, status: 200 } }),
    );
    const svc = new WabotOutboundService();

    const out = await svc.sendNotification({
      user_external_id: '919999990001',
      media: baseMedia,
    });

    expect(out).toEqual({ delivered: true, status: 200 });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://wabot.test/api/sendNotification');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual({
      user_external_id: '919999990001',
      media: baseMedia,
    });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('rethrows + ends span when fetch throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('downstream'));
    const svc = new WabotOutboundService();

    await expect(
      svc.sendNotification({
        user_external_id: '919999990001',
        media: baseMedia,
      }),
    ).rejects.toThrow('downstream');
    expect(mockSpanRecordException).toHaveBeenCalled();
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });
});

describe('WabotOutboundService.downloadMedia', () => {
  it('returns the response body stream and Content-Type header on 2xx', async () => {
    const fakeStream = { kind: 'stream' };
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        body: fakeStream,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );
    const svc = new WabotOutboundService();

    const out = await svc.downloadMedia('https://cdn/v.mp4', carrier);

    expect(out.content_type).toBe('audio/mpeg');
    expect(out.stream).toBe(fakeStream as unknown);
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual({
      media_url: 'https://cdn/v.mp4',
      otel: { carrier },
    });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('defaults content_type to application/octet-stream when header is absent', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({ status: 200, body: {} }),
    );
    const svc = new WabotOutboundService();

    const out = await svc.downloadMedia('https://cdn/v.mp4', carrier);
    expect(out.content_type).toBe('application/octet-stream');
  });

  it('throws on 4XX (and records exception)', async () => {
    global.fetch = jest.fn().mockResolvedValue(fakeResponse({ status: 404 }));
    const svc = new WabotOutboundService();

    await expect(
      svc.downloadMedia('https://cdn/v.mp4', carrier),
    ).rejects.toThrow('download-media failed with 404');
    expect(mockSpanRecordException).toHaveBeenCalled();
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('throws on 5XX', async () => {
    global.fetch = jest.fn().mockResolvedValue(fakeResponse({ status: 502 }));
    const svc = new WabotOutboundService();

    await expect(
      svc.downloadMedia('https://cdn/v.mp4', carrier),
    ).rejects.toThrow('download-media failed with 502');
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('rethrows when fetch throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connect refused'));
    const svc = new WabotOutboundService();
    await expect(
      svc.downloadMedia('https://cdn/v.mp4', carrier),
    ).rejects.toThrow('connect refused');
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });
});

describe('WabotOutboundService.uploadMedia', () => {
  it('POSTs binary data with otel JSON-encoded into the URL query', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: { wa_media_url: 'https://wabot.test/m/abc' },
      }),
    );
    const svc = new WabotOutboundService();
    const data = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    const out = await svc.uploadMedia(data, 'audio/mpeg', 'audio', carrier);

    expect(out).toEqual({ wa_media_url: 'https://wabot.test/m/abc' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    // URL contains percent-encoded JSON of the carrier
    expect(url).toContain('https://wabot.test/api/uploadMedia?otel=');
    const otelParam = (url as string).split('otel=')[1];
    const decoded = JSON.parse(decodeURIComponent(otelParam));
    expect(decoded).toEqual(carrier);

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('audio/mpeg');
    expect(headers['X-Media-Type']).toBe('audio');
    expect(headers['x-api-key']).toBe('test-api-key');

    // body is an ArrayBuffer with the same bytes as the input Buffer
    const sentBody = (init as RequestInit).body as ArrayBuffer;
    expect(sentBody.byteLength).toBe(4);
    expect(Array.from(new Uint8Array(sentBody))).toEqual([
      0xde, 0xad, 0xbe, 0xef,
    ]);
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('throws on 4XX after reading the response text for the log', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({ status: 422, text: 'bad media' }),
    );
    const svc = new WabotOutboundService();
    await expect(
      svc.uploadMedia(Buffer.from([0]), 'audio/mpeg', 'audio', carrier),
    ).rejects.toThrow('uploadMedia failed with 422');
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('throws on 5XX after reading the response text', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({ status: 500, text: 'upstream down' }),
    );
    const svc = new WabotOutboundService();
    await expect(
      svc.uploadMedia(Buffer.from([0]), 'audio/mpeg', 'audio', carrier),
    ).rejects.toThrow('uploadMedia failed with 500');
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('rethrows when fetch throws (network error)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const svc = new WabotOutboundService();
    await expect(
      svc.uploadMedia(Buffer.from([0]), 'audio/mpeg', 'audio', carrier),
    ).rejects.toThrow('socket hang up');
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });
});
