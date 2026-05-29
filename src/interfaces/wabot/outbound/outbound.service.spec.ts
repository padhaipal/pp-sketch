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

// ─── mutation hardening ────────────────────────────────────────────────────

const tracerMock = jest.requireMock('../../../otel/otel') as {
  tracer: { startActiveSpan: jest.Mock };
};

describe('WabotOutboundService — exact span names + endpoint attributes', () => {
  it.each<[
    'sendMessage' | 'sendNotification' | 'downloadMedia' | 'uploadMedia',
    string,
    string,
  ]>([
    ['sendMessage', 'wabot.outbound.sendMessage', 'sendMessage'],
    ['sendNotification', 'wabot.outbound.sendNotification', 'sendNotification'],
    ['downloadMedia', 'wabot.outbound.downloadMedia', 'downloadMedia'],
    ['uploadMedia', 'wabot.outbound.uploadMedia', 'uploadMedia'],
  ])('%s opens span "%s" with wabot.endpoint="%s"', async (op, spanName, ep) => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: { delivered: true, wa_media_url: 'wa://m1' },
        body: 'stream-body',
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );
    const svc = new WabotOutboundService();
    if (op === 'sendMessage') {
      await svc.sendMessage({
        user_external_id: '919999990001',
        wamid: 'w1',
        media: baseMedia,
        otel_carrier: carrier,
      });
    } else if (op === 'sendNotification') {
      await svc.sendNotification({
        user_external_id: '919999990001',
        media: baseMedia,
      });
    } else if (op === 'downloadMedia') {
      await svc.downloadMedia('https://media/x', carrier);
    } else {
      await svc.uploadMedia(Buffer.from([0]), 'audio/mpeg', 'audio', carrier);
    }
    expect(tracerMock.tracer.startActiveSpan).toHaveBeenCalledWith(
      spanName,
      expect.any(Function),
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('wabot.endpoint', ep);
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'http.response.status_code',
      200,
    );
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });
});

describe('WabotOutboundService — exact request URLs + headers', () => {
  it.each<[string, string]>([
    ['sendMessage', 'https://wabot.test/api/sendMessage'],
    ['sendNotification', 'https://wabot.test/api/sendNotification'],
    ['downloadMedia', 'https://wabot.test/api/downloadMedia'],
  ])('%s POSTs to %s with Content-Type application/json + x-api-key', async (op, url) => {
    const fetchSpy = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        json: { delivered: true },
        body: 'stream-body',
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );
    global.fetch = fetchSpy;
    const svc = new WabotOutboundService();
    if (op === 'sendMessage') {
      await svc.sendMessage({
        user_external_id: '919999990001',
        wamid: 'w1',
        media: baseMedia,
        otel_carrier: carrier,
      });
    } else if (op === 'sendNotification') {
      await svc.sendNotification({
        user_external_id: '919999990001',
        media: baseMedia,
      });
    } else {
      await svc.downloadMedia('https://media/x', carrier);
    }
    expect(fetchSpy.mock.calls[0][0]).toBe(url);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['x-api-key']).toBe('test-api-key');
  });

  it('uploadMedia URL: /uploadMedia?otel=<urlencoded JSON carrier>, with Content-Type from arg + X-Media-Type + x-api-key', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(
      fakeResponse({ status: 200, json: { wa_media_url: 'wa://m1' } }),
    );
    global.fetch = fetchSpy;
    const svc = new WabotOutboundService();
    await svc.uploadMedia(
      Buffer.from([0x01, 0x02]),
      'audio/mpeg',
      'audio',
      { traceparent: 'tp' } as never,
    );
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url.startsWith('https://wabot.test/api/uploadMedia?otel=')).toBe(true);
    const otelParam = url.split('otel=')[1];
    expect(JSON.parse(decodeURIComponent(otelParam))).toEqual({ traceparent: 'tp' });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('audio/mpeg');
    expect(headers['X-Media-Type']).toBe('audio');
    expect(headers['x-api-key']).toBe('test-api-key');
  });
});

describe('WabotOutboundService — exact 4XX/5XX boundaries + log messages', () => {
  function setup(op: 'download' | 'upload', status: number, text = '') {
    const fetchSpy = jest.fn().mockResolvedValue(
      fakeResponse({ status, text, json: {}, headers: { 'content-type': 'x' } }),
    );
    global.fetch = fetchSpy;
    return new WabotOutboundService();
  }

  it.each<[number]>([[400], [404], [499]])(
    'downloadMedia status %s is 4XX (kills <500 → <=) and throws',
    async (status) => {
      const svc = setup('download', status);
      await expect(
        svc.downloadMedia('https://m', carrier),
      ).rejects.toThrow(`download-media failed with ${status}`);
    },
  );

  it.each<[number]>([[500], [502], [599]])(
    'downloadMedia status %s is 5XX and throws',
    async (status) => {
      const svc = setup('download', status);
      await expect(
        svc.downloadMedia('https://m', carrier),
      ).rejects.toThrow(`download-media failed with ${status}`);
    },
  );

  it('downloadMedia 399 falls through (no 4XX, no 5XX) and returns the stream', async () => {
    const svc = setup('download', 399);
    // 399 < 400 → no 4XX branch; 399 < 500 → no 5XX branch either; proceeds.
    await expect(svc.downloadMedia('https://m', carrier)).resolves.toBeDefined();
  });

  it('uploadMedia 400 throws + error logged with "uploadMedia 4XX:" prefix', async () => {
    const error = jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const fetchSpy = jest.fn().mockResolvedValue(
      fakeResponse({ status: 422, text: 'bad form' }),
    );
    global.fetch = fetchSpy;
    const svc = new WabotOutboundService();
    await expect(
      svc.uploadMedia(Buffer.from([0]), 'audio/mpeg', 'audio', carrier),
    ).rejects.toThrow('uploadMedia failed with 422');
    expect(error).toHaveBeenCalledWith('uploadMedia 4XX: 422 body=bad form');
    error.mockRestore();
  });

  it('uploadMedia 500 throws + warn logged with "uploadMedia 5XX:" prefix', async () => {
    const warn = jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const fetchSpy = jest.fn().mockResolvedValue(
      fakeResponse({ status: 503, text: 'try later' }),
    );
    global.fetch = fetchSpy;
    const svc = new WabotOutboundService();
    await expect(
      svc.uploadMedia(Buffer.from([0]), 'audio/mpeg', 'audio', carrier),
    ).rejects.toThrow('uploadMedia failed with 503');
    expect(warn).toHaveBeenCalledWith('uploadMedia 5XX: 503 body=try later');
    warn.mockRestore();
  });
});

describe('WabotOutboundService — content-type defaulting', () => {
  it('downloadMedia uses the header value when set', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        body: 'data',
        headers: { 'content-type': 'audio/ogg' },
      }),
    );
    const svc = new WabotOutboundService();
    const out = await svc.downloadMedia('https://m', carrier);
    expect(out.content_type).toBe('audio/ogg');
  });

  it('downloadMedia defaults to application/octet-stream when content-type header is missing', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        body: 'data',
        headers: {},
      }),
    );
    const svc = new WabotOutboundService();
    const out = await svc.downloadMedia('https://m', carrier);
    expect(out.content_type).toBe('application/octet-stream');
  });
});
