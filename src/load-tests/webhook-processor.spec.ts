// Tests for ../load-tests/processors/webhook.js — the artillery processor
// that builds + signs synthetic WhatsApp webhook payloads. Lives under
// src/ so Jest's rootDir picks it up; the processor itself stays in
// load-tests/ so artillery can require() it at runtime.

import { createHmac } from 'node:crypto';

const processor = require('../../load-tests/processors/webhook.js') as {
  prepareWebhook: (
    ctx: { vars: Record<string, unknown> },
    events: unknown,
    next: (err?: Error) => void,
  ) => void;
  prepareWebhookFollowUp: (
    ctx: { vars: Record<string, unknown> },
    events: unknown,
    next: (err?: Error) => void,
  ) => void;
};

const ENV_KEYS = [
  'WHATSAPP_BUSINESS_ACCOUNT_ID',
  'WHATSAPP_PHONE_NUMBER_ID',
  'LOAD_TEST_PHONE_PREFIX',
  'META_APP_SECRET',
];
const SAVED_ENV: Record<string, string | undefined> = {};

function setEnv(): void {
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'biz-acc-1';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'phone-num-1';
  process.env.LOAD_TEST_PHONE_PREFIX = '911000';
  process.env.META_APP_SECRET = 'secret-1';
}

function captureNext(): {
  fn: (err?: Error) => void;
  err: Error | undefined;
  called: boolean;
} {
  const state = { err: undefined as Error | undefined, called: false };
  const fn = (err?: Error): void => {
    state.called = true;
    state.err = err;
  };
  return {
    fn,
    get err() {
      return state.err;
    },
    get called() {
      return state.called;
    },
  } as ReturnType<typeof captureNext>;
}

beforeAll(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

beforeEach(() => {
  setEnv();
});

describe('prepareWebhook', () => {
  it('writes phone, payload, and signature to context.vars and invokes next() w/o error', () => {
    const ctx = { vars: {} as Record<string, unknown> };
    const next = captureNext();
    processor.prepareWebhook(ctx, undefined, next.fn);
    expect(next.called).toBe(true);
    expect(next.err).toBeUndefined();
    expect(typeof ctx.vars.phone).toBe('string');
    expect((ctx.vars.phone as string).startsWith('911000')).toBe(true);
    expect((ctx.vars.phone as string).length).toBe(12);
    expect(typeof ctx.vars.payload).toBe('string');
    expect(typeof ctx.vars.signature).toBe('string');
  });

  it('signature is HMAC-SHA256(payload, META_APP_SECRET) prefixed with sha256=', () => {
    const ctx = { vars: {} as Record<string, unknown> };
    const next = captureNext();
    processor.prepareWebhook(ctx, undefined, next.fn);
    const expected =
      'sha256=' +
      createHmac('sha256', 'secret-1')
        .update(ctx.vars.payload as string)
        .digest('hex');
    expect(ctx.vars.signature).toBe(expected);
  });

  it('payload JSON contains the generated phone in messages[].from and contacts[].wa_id', () => {
    const ctx = { vars: {} as Record<string, unknown> };
    const next = captureNext();
    processor.prepareWebhook(ctx, undefined, next.fn);
    const body = JSON.parse(ctx.vars.payload as string) as {
      entry: Array<{
        id: string;
        changes: Array<{
          value: {
            metadata: { phone_number_id: string };
            messages: Array<{ from: string; type: string }>;
            contacts: Array<{ wa_id: string }>;
          };
        }>;
      }>;
    };
    expect(body.entry[0].id).toBe('biz-acc-1');
    const change = body.entry[0].changes[0].value;
    expect(change.metadata.phone_number_id).toBe('phone-num-1');
    expect(change.messages[0].from).toBe(ctx.vars.phone);
    expect(change.messages[0].type).toBe('text');
    expect(change.contacts[0].wa_id).toBe(ctx.vars.phone);
  });

  it('wamid is fresh (different) on each invocation for the same VU context', () => {
    const ctx = { vars: {} as Record<string, unknown> };
    processor.prepareWebhook(ctx, undefined, () => undefined);
    const payload1 = JSON.parse(ctx.vars.payload as string) as {
      entry: [{ changes: [{ value: { messages: [{ id: string }] } }] }];
    };
    const wamid1 = payload1.entry[0].changes[0].value.messages[0].id;
    processor.prepareWebhook(ctx, undefined, () => undefined);
    const payload2 = JSON.parse(ctx.vars.payload as string) as {
      entry: [{ changes: [{ value: { messages: [{ id: string }] } }] }];
    };
    const wamid2 = payload2.entry[0].changes[0].value.messages[0].id;
    expect(wamid1).not.toBe(wamid2);
    expect(wamid1.startsWith('wamid.LOADTEST_')).toBe(true);
  });

  it.each(ENV_KEYS)(
    'forwards an Error to next() when %s is missing',
    (envKey) => {
      delete process.env[envKey];
      const ctx = { vars: {} as Record<string, unknown> };
      const next = captureNext();
      processor.prepareWebhook(ctx, undefined, next.fn);
      expect(next.err).toBeInstanceOf(Error);
      expect((next.err as Error).message).toMatch(/missing one of/);
    },
  );
});

describe('prepareWebhookFollowUp', () => {
  it('reuses the same phone as prepareWebhook stashed in context.vars', () => {
    const ctx = { vars: {} as Record<string, unknown> };
    processor.prepareWebhook(ctx, undefined, () => undefined);
    const phaseOnePhone = ctx.vars.phone;
    processor.prepareWebhookFollowUp(ctx, undefined, () => undefined);
    expect(ctx.vars.phone).toBe(phaseOnePhone);
    const body = JSON.parse(ctx.vars.payload as string) as {
      entry: [{ changes: [{ value: { messages: [{ from: string }] } }] }];
    };
    expect(body.entry[0].changes[0].value.messages[0].from).toBe(phaseOnePhone);
  });

  it('generates a fresh wamid even when reusing the same phone', () => {
    const ctx = { vars: {} as Record<string, unknown> };
    processor.prepareWebhook(ctx, undefined, () => undefined);
    const phaseOnePayload = JSON.parse(ctx.vars.payload as string) as {
      entry: [{ changes: [{ value: { messages: [{ id: string }] } }] }];
    };
    const phaseOneWamid =
      phaseOnePayload.entry[0].changes[0].value.messages[0].id;
    processor.prepareWebhookFollowUp(ctx, undefined, () => undefined);
    const phaseTwoPayload = JSON.parse(ctx.vars.payload as string) as {
      entry: [{ changes: [{ value: { messages: [{ id: string }] } }] }];
    };
    const phaseTwoWamid =
      phaseTwoPayload.entry[0].changes[0].value.messages[0].id;
    expect(phaseTwoWamid).not.toBe(phaseOneWamid);
  });

  it('recomputes a fresh signature for the new payload', () => {
    const ctx = { vars: {} as Record<string, unknown> };
    processor.prepareWebhook(ctx, undefined, () => undefined);
    const sigOne = ctx.vars.signature;
    processor.prepareWebhookFollowUp(ctx, undefined, () => undefined);
    expect(ctx.vars.signature).not.toBe(sigOne);
    const expected =
      'sha256=' +
      createHmac('sha256', 'secret-1')
        .update(ctx.vars.payload as string)
        .digest('hex');
    expect(ctx.vars.signature).toBe(expected);
  });

  it('forwards an Error to next() if context.vars.phone is missing', () => {
    const ctx = { vars: {} as Record<string, unknown> };
    const next = captureNext();
    processor.prepareWebhookFollowUp(ctx, undefined, next.fn);
    expect(next.err).toBeInstanceOf(Error);
    expect((next.err as Error).message).toMatch(/phone is missing/);
  });

  it('forwards an Error to next() when META_APP_SECRET is missing', () => {
    const ctx = { vars: { phone: '911000123456' } as Record<string, unknown> };
    delete process.env.META_APP_SECRET;
    const next = captureNext();
    processor.prepareWebhookFollowUp(ctx, undefined, next.fn);
    expect(next.err).toBeInstanceOf(Error);
    expect((next.err as Error).message).toMatch(/missing one of/);
  });
});
