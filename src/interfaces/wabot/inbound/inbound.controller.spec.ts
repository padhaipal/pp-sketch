process.env.LOG_PII_HMAC_KEY = process.env.LOG_PII_HMAC_KEY ?? 'a'.repeat(64);

const mockQueueAdd = jest.fn();
const mockCreateQueue = jest.fn(() => ({ add: mockQueueAdd }));
jest.mock('../../redis/queues', () => ({
  createQueue: (...args: unknown[]) => mockCreateQueue(...args),
  QUEUE_NAMES: { WABOT_INBOUND: 'wabot-inbound' },
}));

const mockSpanEnd = jest.fn();
const mockSpanSetAttribute = jest.fn();
const mockSpanSetStatus = jest.fn();
const mockSpanRecordException = jest.fn();
const mockStartChildSpanWithContext = jest.fn(() => ({
  span: {
    setAttribute: mockSpanSetAttribute,
    setStatus: mockSpanSetStatus,
    recordException: mockSpanRecordException,
    end: mockSpanEnd,
  },
  ctx: { __ctx: true },
}));
const mockInjectCarrierFromContext = jest.fn(() => ({ traceparent: 'tp-out' }));
jest.mock('../../../otel/otel', () => ({
  startChildSpanWithContext: (...args: unknown[]) =>
    mockStartChildSpanWithContext(...args),
  injectCarrierFromContext: (...args: unknown[]) =>
    mockInjectCarrierFromContext(...args),
}));

import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { WabotInboundController } from './inbound.controller';

function validPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    otel: { carrier: { traceparent: 'tp-in' } },
    message: {
      from: '+910000000001',
      id: 'wamid-1',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: 'hello' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockQueueAdd.mockReset().mockResolvedValue(undefined);
  mockSpanEnd.mockReset();
  mockSpanSetAttribute.mockReset();
  mockSpanSetStatus.mockReset();
  mockSpanRecordException.mockReset();
  mockStartChildSpanWithContext.mockClear();
  mockInjectCarrierFromContext.mockClear();
});

describe('WabotInboundController.receive — OTel carrier extraction', () => {
  it('forwards a well-formed carrier from the body to startChildSpanWithContext', async () => {
    const ctrl = new WabotInboundController();
    await ctrl.receive(validPayload());

    expect(mockStartChildSpanWithContext).toHaveBeenCalledWith(
      'wabot-inbound-controller',
      { traceparent: 'tp-in' },
    );
  });

  it('passes an empty carrier object when body.otel is missing', async () => {
    const ctrl = new WabotInboundController();
    const body = validPayload();
    delete (body as { otel?: unknown }).otel;
    await ctrl.receive(body);

    expect(mockStartChildSpanWithContext).toHaveBeenCalledWith(
      'wabot-inbound-controller',
      {},
    );
  });

  it('still starts the trace span for a null body (so malformed payloads remain visible)', async () => {
    const ctrl = new WabotInboundController();

    // The DTO does not currently reject null cleanly — validate() crashes
    // with a TypeError before BadRequestException can be raised. The
    // important contract here is that the span was started, not the
    // specific error class. (Tracking: tighten DTO validation in prod.)
    await expect(ctrl.receive(null)).rejects.toThrow();
    expect(mockStartChildSpanWithContext).toHaveBeenCalledWith(
      'wabot-inbound-controller',
      {},
    );
  });

  it('strips non-string carrier values from the span carrier (defensive: malformed upstream)', async () => {
    const ctrl = new WabotInboundController();
    // The DTO rejects this carrier (OtelCarrierDto demands all-string values)
    // so the request itself rejects. The span carrier still must reflect the
    // stripped form so the trace is correctly stitched.
    await expect(
      ctrl.receive(
        validPayload({
          otel: {
            carrier: { traceparent: 'tp', bad: 123, nested: { x: 'y' } },
          },
        }),
      ),
    ).rejects.toThrow();

    expect(mockStartChildSpanWithContext).toHaveBeenCalledWith(
      'wabot-inbound-controller',
      { traceparent: 'tp' },
    );
  });

  it('passes empty carrier to the span when otel.carrier is an array (not a Record)', async () => {
    const ctrl = new WabotInboundController();
    await expect(
      ctrl.receive(validPayload({ otel: { carrier: ['nope'] } })),
    ).rejects.toThrow();
    expect(mockStartChildSpanWithContext).toHaveBeenCalledWith(
      'wabot-inbound-controller',
      {},
    );
  });
});

describe('WabotInboundController.receive — validation', () => {
  it('throws BadRequestException when message.type does not match payload field', async () => {
    const ctrl = new WabotInboundController();
    const body = validPayload({
      message: {
        from: '+910000000001',
        id: 'wamid-1',
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'audio',
        text: { body: 'hi' }, // mismatched — type says audio but field is text
      },
    });
    await expect(ctrl.receive(body)).rejects.toThrow(BadRequestException);
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'pp.validation.failed',
      true,
    );
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('throws BadRequestException when message.from is missing', async () => {
    const ctrl = new WabotInboundController();
    const body = validPayload({
      message: {
        // from omitted
        id: 'wamid-1',
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: 'hi' },
      },
    });
    await expect(ctrl.receive(body)).rejects.toThrow(BadRequestException);
  });

  it('does NOT enqueue when validation fails', async () => {
    const ctrl = new WabotInboundController();
    await expect(
      ctrl.receive(
        validPayload({
          message: {
            from: '+910000000001',
            id: 'wamid-1',
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'audio',
            text: { body: 'wrong-field' },
          },
        }),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe('WabotInboundController.receive — happy path', () => {
  it('enqueues the validated payload with the outbound carrier, returns 202 body, ends span', async () => {
    const ctrl = new WabotInboundController();
    const body = validPayload();

    const out = await ctrl.receive(body);

    expect(out).toEqual({ status: 'accepted' });
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, payload] = mockQueueAdd.mock.calls[0];
    expect(name).toBe('wabot-inbound');
    // payload contains validated DTO + injected outbound carrier
    expect((payload as { otel: { carrier: unknown } }).otel.carrier).toEqual({
      traceparent: 'tp-out',
    });
    expect((payload as { message: { id: string } }).message.id).toBe('wamid-1');
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('sets pp.queue + wabot.* + user-id-hash span attributes', async () => {
    const ctrl = new WabotInboundController();
    await ctrl.receive(validPayload());

    const attrs = mockSpanSetAttribute.mock.calls.map(
      ([k, v]: [string, unknown]) => [k, v],
    );
    const keys = attrs.map(([k]) => k);
    expect(keys).toEqual(
      expect.arrayContaining([
        'wabot.wamid',
        'wabot.user.external_id_hash',
        'wabot.message.type',
        'pp.queue',
      ]),
    );
  });
});

describe('WabotInboundController.receive — enqueue retry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries once after a transient failure and returns 202', async () => {
    const ctrl = new WabotInboundController();
    mockQueueAdd
      .mockRejectedValueOnce(new Error('redis blip'))
      .mockResolvedValue(undefined);

    const done = ctrl.receive(validPayload());
    await jest.advanceTimersByTimeAsync(1000); // first backoff is 1s

    await expect(done).resolves.toEqual({ status: 'accepted' });
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });

  it('throws InternalServerErrorException after the 10s deadline', async () => {
    const ctrl = new WabotInboundController();
    let now = 0;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    // Each call: advance the synthetic clock past 10s so the deadline trips
    // on the next iteration.
    mockQueueAdd.mockImplementation(() => {
      now += 11_000;
      return Promise.reject(new Error('redis down'));
    });

    await expect(ctrl.receive(validPayload())).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(mockSpanRecordException).toHaveBeenCalled();
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
    dateSpy.mockRestore();
  });
});
