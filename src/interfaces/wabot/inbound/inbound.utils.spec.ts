process.env.LOG_PII_HMAC_KEY = process.env.LOG_PII_HMAC_KEY ?? 'a'.repeat(64);

import { Logger } from '@nestjs/common';
import {
  appendFlowItem,
  appendMediaItems,
  handleSendResult,
  parseNfmReplyAnswerId,
  persistAndTranscribeAudio,
  sendAudioOnlyRedirect,
  sendFallbackAndHandle,
  shuffled,
} from './inbound.utils';
import type { MessageJobDto } from './wabot-inbound.dto';
import type { OutboundMediaItem } from '../outbound/outbound.dto';
import type { OutboundSentItem } from '../../../outbound-messages/outbound-message.dto';

jest.mock('../../../notifier/hail-mary.processor', () => ({
  rearmHailMary: jest.fn().mockResolvedValue(undefined),
}));

// Distinct sentinels so otel_carrier args can be asserted exactly:
// injectCarrier(span) carries the span; injectCarrierFromContext(ctx) the ctx.
jest.mock('../../../otel/otel', () => ({
  injectCarrier: jest.fn(() => ({ from: 'span' })),
  injectCarrierFromContext: jest.fn(() => ({ from: 'ctx' })),
}));

const USER = { id: 'user-1', external_id: '+910000000001' } as any;
const CTX = { __ctx: true } as any;
const SPAN = { __span: true } as any;

function audioPayload(): MessageJobDto {
  return {
    message: {
      from: '+910000000001',
      id: 'wamid-test-1',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'audio',
      audio: { url: 'https://example.com/audio' },
    },
    otel: { carrier: {} },
  } as any;
}

function textPayload(): MessageJobDto {
  return {
    message: {
      from: '+910000000001',
      id: 'wamid-text-1',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: 'hello' },
    },
    otel: { carrier: {} },
  } as any;
}

function spyLogger() {
  const error = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  const warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  const joined = (spy: jest.SpyInstance) =>
    spy.mock.calls.map((c) => String(c[0])).join('\n');
  return {
    error,
    warn,
    errors: () => joined(error),
    warns: () => joined(warn),
    restore: () => {
      error.mockRestore();
      warn.mockRestore();
    },
  };
}

describe('parseNfmReplyAnswerId', () => {
  it('returns the answer_id from a well-formed nfm_reply', () => {
    expect(
      parseNfmReplyAnswerId({
        type: 'nfm_reply',
        nfm_reply: { response_json: '{"answer_id":"opt-9"}' },
      }),
    ).toBe('opt-9');
  });

  it.each([
    ['not json', 'garbage'],
    ['missing answer_id', '{"other":"x"}'],
    ['non-string answer_id', '{"answer_id":42}'],
    ['empty answer_id', '{"answer_id":""}'],
    ['oversized answer_id', `{"answer_id":"${'x'.repeat(200)}"}`],
    ['empty response_json', ''],
    [
      'oversized response_json',
      `{"answer_id":"a","pad":"${'x'.repeat(10_001)}"}`,
    ],
  ])('returns null for %s', (_label, responseJson) => {
    expect(
      parseNfmReplyAnswerId({
        type: 'nfm_reply',
        nfm_reply: { response_json: responseJson },
      }),
    ).toBeNull();
  });

  it('returns null when interactive is missing or has no nfm_reply', () => {
    expect(parseNfmReplyAnswerId(undefined)).toBeNull();
    expect(parseNfmReplyAnswerId(null)).toBeNull();
    expect(parseNfmReplyAnswerId({ type: 'button_reply' })).toBeNull();
  });
});

describe('shuffled', () => {
  it('returns a permutation and leaves the input untouched', () => {
    const input = Object.freeze([1, 2, 3, 4, 5]);
    const out = shuffled(input);
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });

  it('varies the order across calls', () => {
    const orders = new Set<string>();
    for (let i = 0; i < 25; i++) {
      orders.add(shuffled(['a', 'b', 'c', 'd']).join(','));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('appendFlowItem', () => {
  const FLOW_ENTITY = {
    id: 'flow-media-1',
    text: JSON.stringify({
      question_text: 'कहानी किसके बारे में है?',
      options: [
        { id: 'opt-a', text: 'पहला', correct: true },
        { id: 'opt-b', text: 'दूसरा', correct: false },
        { id: 'opt-c', text: 'x'.repeat(400), correct: false },
      ],
    }),
  };
  let log: ReturnType<typeof spyLogger>;

  beforeEach(() => {
    process.env.WHATSAPP_COMPREHENSION_FLOW_ID = 'flow-asset-1';
    log = spyLogger();
  });
  afterEach(() => {
    delete process.env.WHATSAPP_COMPREHENSION_FLOW_ID;
    log.restore();
    jest.clearAllMocks();
  });

  it('builds the flow item with shuffled options titled A-C and records the row', () => {
    const items: OutboundMediaItem[] = [];
    const records: OutboundSentItem[] = [];
    appendFlowItem(items, FLOW_ENTITY, records, 'stid-1');

    expect(items).toHaveLength(1);
    const flowItem = items[0] as any;
    expect(flowItem.type).toBe('flow');
    expect(flowItem.flow.flow_id).toBe('flow-asset-1');
    expect(flowItem.flow.screen).toBe('COMPREHENSION');
    expect(flowItem.flow.data.question_text).toBe('कहानी किसके बारे में है?');
    expect(flowItem.flow.data.options.map((o: any) => o.title)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(flowItem.flow.data.options.map((o: any) => o.id).sort()).toEqual([
      'opt-a',
      'opt-b',
      'opt-c',
    ]);
    // Option descriptions are capped at Meta's 300-char limit.
    const longest = flowItem.flow.data.options.find(
      (o: any) => o.id === 'opt-c',
    );
    expect(longest.description).toHaveLength(300);
    expect(records).toEqual([
      { media_metadata_id: 'flow-media-1', state_transition_id: 'stid-1' },
    ]);
  });

  it('shuffles the option order across sends', () => {
    const orders = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const items: OutboundMediaItem[] = [];
      appendFlowItem(items, FLOW_ENTITY);
      orders.add(
        (items[0] as any).flow.data.options.map((o: any) => o.id).join(','),
      );
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('records a null state_transition_id when none is given, and nothing without a records array', () => {
    const items: OutboundMediaItem[] = [];
    const records: OutboundSentItem[] = [];
    appendFlowItem(items, FLOW_ENTITY, records);
    expect(records).toEqual([
      { media_metadata_id: 'flow-media-1', state_transition_id: null },
    ]);
    expect(() => appendFlowItem([], FLOW_ENTITY)).not.toThrow();
  });

  it('skips the item and logs an error when the flow env id is missing', () => {
    delete process.env.WHATSAPP_COMPREHENSION_FLOW_ID;
    const items: OutboundMediaItem[] = [];
    const records: OutboundSentItem[] = [];
    appendFlowItem(items, FLOW_ENTITY, records, 'stid-1');
    expect(items).toEqual([]);
    expect(records).toEqual([]);
    expect(log.errors()).toMatch(/WHATSAPP_COMPREHENSION_FLOW_ID is not set/);
  });

  it('skips a row with an unparseable payload', () => {
    const items: OutboundMediaItem[] = [];
    appendFlowItem(items, { id: 'flow-bad', text: 'not json' });
    expect(items).toEqual([]);
    expect(log.errors()).toMatch(/flow-bad has unparseable payload/);
  });

  it.each([
    ['no options', '{"question_text":"q"}'],
    [
      'non-string question',
      '{"question_text":1,"options":[{"id":"a","text":"a"},{"id":"b","text":"b"}]}',
    ],
    [
      'too few options',
      '{"question_text":"q","options":[{"id":"a","text":"a"}]}',
    ],
    [
      'too many options',
      JSON.stringify({
        question_text: 'q',
        options: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, text: id })),
      }),
    ],
    ['null text', null],
  ])('skips a row with a malformed payload (%s)', (_label, text) => {
    const items: OutboundMediaItem[] = [];
    appendFlowItem(items, { id: 'flow-bad', text });
    expect(items).toEqual([]);
    expect(log.errors()).toMatch(
      /flow-bad has (malformed|unparseable) payload/,
    );
  });
});

describe('appendMediaItems', () => {
  beforeEach(() => {
    process.env.WHATSAPP_COMPREHENSION_FLOW_ID = 'flow-asset-1';
  });
  afterEach(() => {
    delete process.env.WHATSAPP_COMPREHENSION_FLOW_ID;
  });

  it('maps each media type in video, audio, image, sticker, text order with the flow last', () => {
    const items: OutboundMediaItem[] = [];
    const records: OutboundSentItem[] = [];
    appendMediaItems(
      items,
      {
        text: { id: 't', text: 'शाबाश' },
        flow: {
          id: 'f',
          text: JSON.stringify({
            question_text: 'q',
            options: [
              { id: 'a', text: 'a' },
              { id: 'b', text: 'b' },
            ],
          }),
        },
        sticker: { id: 's', wa_media_url: 'wa-s', media_details: null },
        image: {
          id: 'i',
          wa_media_url: 'wa-i',
          media_details: { mime_type: 'image/png' },
        },
        audio: {
          id: 'a',
          wa_media_url: 'wa-a',
          media_details: { mime_type: 'audio/mpeg' },
        },
        video: {
          id: 'v',
          wa_media_url: 'wa-v',
          media_details: { mime_type: 'video/mp4' },
        },
      } as any,
      records,
      'stid-1',
    );

    expect(items.map((m) => m.type)).toEqual([
      'video',
      'audio',
      'image',
      'sticker',
      'text',
      'flow',
    ]);
    expect(items).toContainEqual({
      type: 'video',
      url: 'wa-v',
      mime_type: 'video/mp4',
    });
    expect(items).toContainEqual({ type: 'text', body: 'शाबाश' });
    expect(records.map((r) => r.media_metadata_id)).toEqual([
      'v',
      'a',
      'i',
      's',
      't',
      'f',
    ]);
    expect(records.every((r) => r.state_transition_id === 'stid-1')).toBe(true);
  });

  it('emits a media item with undefined mime_type when media_details is null', () => {
    const items: OutboundMediaItem[] = [];
    appendMediaItems(items, {
      image: { id: 'i', wa_media_url: 'https://wa/i.png', media_details: null },
    } as any);
    expect(items).toEqual([
      { type: 'image', url: 'https://wa/i.png', mime_type: undefined },
    ]);
  });

  it('appends nothing for an empty lookup', () => {
    const items: OutboundMediaItem[] = [];
    const records: OutboundSentItem[] = [];
    appendMediaItems(items, {} as any, records, 'stid-1');
    expect(items).toEqual([]);
    expect(records).toEqual([]);
  });
});

describe('handleSendResult', () => {
  let log: ReturnType<typeof spyLogger>;
  beforeEach(() => {
    log = spyLogger();
  });
  afterEach(() => log.restore());

  it('logs an error for a 4XX under the given label', () => {
    handleSendResult({ status: 422, body: {} }, 'audio-only');
    expect(log.errors()).toMatch(/^audio-only sendMessage 4XX: 422$/m);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs a warning for a 5XX under the given label', () => {
    handleSendResult({ status: 503, body: {} }, 'new-user-onboarding');
    expect(log.warns()).toMatch(/^new-user-onboarding sendMessage 5XX: 503$/m);
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each([200, 204, 399])('is silent for status %i', (status) => {
    handleSendResult({ status, body: {} }, 'x');
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('sendFallbackAndHandle', () => {
  let log: ReturnType<typeof spyLogger>;
  beforeEach(() => {
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/fallback.mp4';
    log = spyLogger();
  });
  afterEach(() => {
    delete process.env.FALL_BACK_MESSAGE_PUBLIC_URL;
    log.restore();
    jest.clearAllMocks();
  });

  it('sends the fallback video to the sender with the ctx carrier', async () => {
    const wabotOutbound = {
      sendMessage: jest.fn().mockResolvedValue({ status: 200, body: {} }),
    };
    await sendFallbackAndHandle(wabotOutbound as any, textPayload(), CTX);
    expect(wabotOutbound.sendMessage).toHaveBeenCalledWith({
      user_external_id: '+910000000001',
      wamid: 'wamid-text-1',
      media: [{ type: 'video', url: 'https://cdn/fallback.mp4' }],
      otel_carrier: { from: 'ctx' },
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs a warning and does not throw when the send fails', async () => {
    const wabotOutbound = {
      sendMessage: jest.fn().mockRejectedValue(new Error('wabot down')),
    };
    await expect(
      sendFallbackAndHandle(wabotOutbound as any, textPayload(), CTX),
    ).resolves.toBeUndefined();
    expect(log.warns()).toMatch(/Failed to send fallback message: wabot down/);
  });
});

describe('sendAudioOnlyRedirect', () => {
  let log: ReturnType<typeof spyLogger>;
  beforeEach(() => {
    log = spyLogger();
  });
  afterEach(() => {
    log.restore();
    jest.clearAllMocks();
  });

  function deps(sendResult: unknown = { status: 200, body: {} }) {
    return {
      mediaMetaDataService: {
        findMediaByStateTransitionId: jest.fn().mockResolvedValue({
          video: {
            wa_media_url: 'https://wa/audio-only.mp4',
            media_details: null,
          },
        }),
      },
      wabotOutbound: {
        sendMessage: jest.fn().mockResolvedValue(sendResult),
      },
    };
  }

  it('sends the audio-only prompt video with the ctx carrier', async () => {
    const d = deps();
    await sendAudioOnlyRedirect(
      d.mediaMetaDataService as any,
      d.wabotOutbound as any,
      { user: USER, payload: textPayload(), ctx: CTX },
    );
    expect(
      d.mediaMetaDataService.findMediaByStateTransitionId,
    ).toHaveBeenCalledWith('audio-only-request');
    expect(d.wabotOutbound.sendMessage).toHaveBeenCalledWith({
      user_external_id: '+910000000001',
      wamid: 'wamid-text-1',
      media: [{ type: 'video', url: 'https://wa/audio-only.mp4' }],
      otel_carrier: { from: 'ctx' },
    });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('fails loud when the audio-only media is not seeded', async () => {
    const d = deps();
    d.mediaMetaDataService.findMediaByStateTransitionId.mockResolvedValue({});
    await expect(
      sendAudioOnlyRedirect(
        d.mediaMetaDataService as any,
        d.wabotOutbound as any,
        {
          user: USER,
          payload: textPayload(),
          ctx: CTX,
        },
      ),
    ).rejects.toThrow(/audio-only redirect media missing/);
    expect(log.errors()).toMatch(/Missing media for audio-only-request/);
    expect(d.wabotOutbound.sendMessage).not.toHaveBeenCalled();
  });

  it('logs a 4XX from the send without throwing', async () => {
    const d = deps({ status: 422, body: {} });
    await sendAudioOnlyRedirect(
      d.mediaMetaDataService as any,
      d.wabotOutbound as any,
      {
        user: USER,
        payload: textPayload(),
        ctx: CTX,
      },
    );
    expect(log.errors()).toMatch(/audio-only sendMessage 4XX: 422/);
  });

  it('logs a 5XX from the send without throwing', async () => {
    const d = deps({ status: 503, body: {} });
    await sendAudioOnlyRedirect(
      d.mediaMetaDataService as any,
      d.wabotOutbound as any,
      {
        user: USER,
        payload: textPayload(),
        ctx: CTX,
      },
    );
    expect(log.warns()).toMatch(/audio-only sendMessage 5XX: 503/);
  });

  it('logs a warning and does not throw when the send rejects', async () => {
    const d = deps();
    d.wabotOutbound.sendMessage.mockRejectedValue(new Error('wabot down'));
    await expect(
      sendAudioOnlyRedirect(
        d.mediaMetaDataService as any,
        d.wabotOutbound as any,
        {
          user: USER,
          payload: textPayload(),
          ctx: CTX,
        },
      ),
    ).resolves.toBeUndefined();
    expect(log.warns()).toMatch(
      /Failed to send audio-only message: wabot down/,
    );
  });
});

describe('persistAndTranscribeAudio', () => {
  let log: ReturnType<typeof spyLogger>;
  beforeEach(() => {
    log = spyLogger();
  });
  afterEach(() => {
    log.restore();
    jest.clearAllMocks();
  });

  function service(transcripts: unknown[] = [{ id: 'tr-1', text: 'ओम' }]) {
    return {
      createWhatsappAudioMedia: jest
        .fn()
        .mockResolvedValue({ id: 'audio-entity-1' }),
      findTranscripts: jest.fn().mockResolvedValue(transcripts),
    };
  }

  it('persists the voice note, re-arms hail-mary and returns the transcripts', async () => {
    const { rearmHailMary } = jest.requireMock(
      '../../../notifier/hail-mary.processor',
    );
    const svc = service();
    const result = await persistAndTranscribeAudio(svc as any, {
      payload: audioPayload(),
      user: USER,
      span: SPAN,
    });

    expect(svc.createWhatsappAudioMedia).toHaveBeenCalledWith({
      wa_media_url: 'https://example.com/audio',
      user: USER,
      otel_carrier: { from: 'span' },
    });
    expect(rearmHailMary).toHaveBeenCalledWith({
      user_id: 'user-1',
      user_external_id: '+910000000001',
      user_message_id: 'audio-entity-1',
      otel_carrier: { from: 'span' },
    });
    expect(svc.findTranscripts).toHaveBeenCalledWith({
      media_metadata: { id: 'audio-entity-1' },
    });
    expect(result).toEqual({
      audioEntity: { id: 'audio-entity-1' },
      transcripts: [{ id: 'tr-1', text: 'ओम' }],
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('tolerates rearmHailMary throwing (logs, still returns transcripts)', async () => {
    const { rearmHailMary } = jest.requireMock(
      '../../../notifier/hail-mary.processor',
    );
    rearmHailMary.mockRejectedValueOnce(new Error('queue down'));
    const svc = service();
    const result = await persistAndTranscribeAudio(svc as any, {
      payload: audioPayload(),
      user: USER,
      span: SPAN,
    });
    expect(result.transcripts).toHaveLength(1);
    expect(log.warns()).toMatch(/rearmHailMary failed for user .*: queue down/);
  });

  it('throws when no transcripts exist', async () => {
    const svc = service([]);
    await expect(
      persistAndTranscribeAudio(svc as any, {
        payload: audioPayload(),
        user: USER,
        span: SPAN,
      }),
    ).rejects.toThrow('No transcripts');
    expect(log.errors()).toMatch(
      /No transcripts found for audio audio-entity-1/,
    );
  });
});
