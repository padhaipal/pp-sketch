const mockQueueAdd = jest.fn();
const mockCreateQueue = jest.fn(() => ({ add: mockQueueAdd }));
jest.mock('../../redis/queues', () => ({
  createQueue: (...args: unknown[]) => mockCreateQueue(...args),
  QUEUE_NAMES: { HEYGEN_INBOUND: 'heygen-inbound' },
}));

const mockSpanEnd = jest.fn();
const mockStartRootSpan = jest.fn(() => ({ end: mockSpanEnd }));
const mockInjectCarrier = jest.fn(() => ({ traceparent: 'tp' }));
jest.mock('../../../otel/otel', () => ({
  startRootSpan: (...args: unknown[]) => mockStartRootSpan(...args),
  injectCarrier: (...args: unknown[]) => mockInjectCarrier(...args),
}));

import * as crypto from 'crypto';
import {
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { HeygenInboundController } from './inbound.controller';

const SECRET = 'shh';
process.env.HEYGEN_WEBHOOK_SECRET = SECRET;

function sign(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

function makeReq(opts: {
  rawBody?: Buffer | null;
  body: unknown;
  signatureHeader?: string;
}): any {
  return {
    rawBody: opts.rawBody ?? undefined,
    body: opts.body,
    headers: opts.signatureHeader
      ? { signature: opts.signatureHeader }
      : {},
  };
}

const validPayload = {
  event_type: 'avatar_video.success',
  event_data: { video_id: 'v1', url: 'https://cdn/v.mp4', callback_id: 'cb1' },
};

beforeEach(() => {
  mockQueueAdd.mockReset().mockResolvedValue(undefined);
  mockSpanEnd.mockReset();
  mockStartRootSpan.mockClear();
  mockInjectCarrier.mockClear();
});

describe('HeygenInboundController.receive — signature verification', () => {
  it('throws UnauthorizedException when Signature header is missing', async () => {
    const ctl = new HeygenInboundController();
    const raw = JSON.stringify(validPayload);
    const req = makeReq({ rawBody: Buffer.from(raw), body: validPayload });

    await expect(ctl.receive(req)).rejects.toThrow(UnauthorizedException);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException on signature length mismatch', async () => {
    const ctl = new HeygenInboundController();
    const raw = JSON.stringify(validPayload);
    const req = makeReq({
      rawBody: Buffer.from(raw),
      body: validPayload,
      signatureHeader: 'short',
    });

    await expect(ctl.receive(req)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when same-length signature differs', async () => {
    const ctl = new HeygenInboundController();
    const raw = JSON.stringify(validPayload);
    const valid = sign(raw);
    const wrong = valid.replace(/./, (c) => (c === '0' ? '1' : '0'));
    const req = makeReq({
      rawBody: Buffer.from(raw),
      body: validPayload,
      signatureHeader: wrong,
    });

    await expect(ctl.receive(req)).rejects.toThrow(UnauthorizedException);
  });

  it('falls back to JSON.stringify(req.body) when rawBody is not a Buffer', async () => {
    const ctl = new HeygenInboundController();
    const raw = JSON.stringify(validPayload);
    const req = makeReq({
      rawBody: null,
      body: validPayload,
      signatureHeader: sign(raw),
    });

    await expect(ctl.receive(req)).resolves.toEqual({ status: 'ok' });
  });
});

describe('HeygenInboundController.receive — body validation', () => {
  it('throws BadRequestException when event_type is invalid', async () => {
    const ctl = new HeygenInboundController();
    const bad = { event_type: 'not_a_real_event', event_data: { x: 1 } };
    const raw = JSON.stringify(bad);
    const req = makeReq({
      rawBody: Buffer.from(raw),
      body: bad,
      signatureHeader: sign(raw),
    });

    await expect(ctl.receive(req)).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when event_data is empty', async () => {
    const ctl = new HeygenInboundController();
    const bad = { event_type: 'avatar_video.success', event_data: {} };
    const raw = JSON.stringify(bad);
    const req = makeReq({
      rawBody: Buffer.from(raw),
      body: bad,
      signatureHeader: sign(raw),
    });

    await expect(ctl.receive(req)).rejects.toThrow(BadRequestException);
  });

  it('parses req.body when it arrives as a JSON string', async () => {
    const ctl = new HeygenInboundController();
    const raw = JSON.stringify(validPayload);
    const req = makeReq({
      rawBody: Buffer.from(raw),
      body: raw, // string form
      signatureHeader: sign(raw),
    });

    await expect(ctl.receive(req)).resolves.toEqual({ status: 'ok' });
  });
});

describe('HeygenInboundController.receive — success path', () => {
  it('enqueues, ends span, returns {status:"ok"}', async () => {
    const ctl = new HeygenInboundController();
    const raw = JSON.stringify(validPayload);
    const req = makeReq({
      rawBody: Buffer.from(raw),
      body: validPayload,
      signatureHeader: sign(raw),
    });

    const out = await ctl.receive(req);

    expect(out).toEqual({ status: 'ok' });
    expect(mockStartRootSpan).toHaveBeenCalledWith('heygen-inbound-controller');
    expect(mockQueueAdd).toHaveBeenCalledWith('heygen-inbound', {
      event_type: 'avatar_video.success',
      event_data: validPayload.event_data,
      otel_carrier: { traceparent: 'tp' },
    });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });
});

describe('HeygenInboundController.receive — enqueue retry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries the enqueue after a transient failure and returns OK', async () => {
    const ctl = new HeygenInboundController();
    mockQueueAdd
      .mockRejectedValueOnce(new Error('redis blip'))
      .mockResolvedValue(undefined);

    const raw = JSON.stringify(validPayload);
    const req = makeReq({
      rawBody: Buffer.from(raw),
      body: validPayload,
      signatureHeader: sign(raw),
    });

    const done = ctl.receive(req);
    // Advance past the 1s backoff for the first retry.
    await jest.advanceTimersByTimeAsync(1000);

    await expect(done).resolves.toEqual({ status: 'ok' });
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
  });

  it('throws InternalServerErrorException after exceeding the 10s retry budget', async () => {
    const ctl = new HeygenInboundController();
    let now = 0;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    // First attempt fails; advance synthetic clock past 10s so the next loop
    // iteration trips the deadline check.
    mockQueueAdd.mockImplementation(() => {
      now += 11_000;
      return Promise.reject(new Error('redis down'));
    });

    const raw = JSON.stringify(validPayload);
    const req = makeReq({
      rawBody: Buffer.from(raw),
      body: validPayload,
      signatureHeader: sign(raw),
    });

    await expect(ctl.receive(req)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
    dateSpy.mockRestore();
  });
});

// ─── mutation hardening ────────────────────────────────────────────────────

import { Logger as NestLogger } from '@nestjs/common';

function spyHLog() {
  return {
    warn: jest.spyOn(NestLogger.prototype, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(NestLogger.prototype, 'error').mockImplementation(() => undefined),
  };
}

describe('HeygenInboundController.receive — exact error messages + log messages', () => {
  it('missing signature: warn "Missing Signature header" + UnauthorizedException "Missing signature"', async () => {
    const { warn } = spyHLog();
    const ctrl = new HeygenInboundController();
    await expect(
      ctrl.receive({
        rawBody: Buffer.from('{}'),
        body: {},
        headers: {},
      } as never),
    ).rejects.toThrow('Missing signature');
    expect(warn).toHaveBeenCalledWith('Missing Signature header');
    warn.mockRestore();
  });

  it('bad signature: warn "HeyGen webhook signature mismatch" + UnauthorizedException "Invalid signature"', async () => {
    const { warn } = spyHLog();
    const ctrl = new HeygenInboundController();
    await expect(
      ctrl.receive({
        rawBody: Buffer.from('{}'),
        body: {},
        // 'wrong' has length 5 — same length as a valid hex would be 64, so
        // the length check fails first; either way we hit the same warn+throw.
        headers: { signature: 'wrong' },
      } as never),
    ).rejects.toThrow('Invalid signature');
    expect(warn).toHaveBeenCalledWith('HeyGen webhook signature mismatch');
    warn.mockRestore();
  });

  it('invalid body throws BadRequestException with exact "Invalid webhook payload"', async () => {
    const ctrl = new HeygenInboundController();
    const rawBody = JSON.stringify({ event_type: 'NOPE', event_data: {} });
    const signature = require('crypto')
      .createHmac('sha256', process.env.HEYGEN_WEBHOOK_SECRET!)
      .update(rawBody)
      .digest('hex');
    await expect(
      ctrl.receive({
        rawBody: Buffer.from(rawBody),
        body: JSON.parse(rawBody),
        headers: { signature },
      } as never),
    ).rejects.toThrow('Invalid webhook payload');
  });
});
