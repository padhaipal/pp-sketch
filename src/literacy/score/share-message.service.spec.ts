// The LLM clients import the OpenTelemetry SDK through ../../otel/otel, whose
// exporters keep a lone Jest process alive; stub the tracer as the processor
// specs do.
jest.mock('../../otel/otel', () => ({
  tracer: {
    startActiveSpan: (_name: string, fn: (span: unknown) => unknown) =>
      fn({
        setAttribute: () => undefined,
        setStatus: () => undefined,
        recordException: () => undefined,
        end: () => undefined,
      }),
  },
  injectCarrier: () => ({}),
}));

import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ANONYMOUS, STAFF } from '../../auth/viewer';
import type { CacheService } from '../../interfaces/redis/cache';
import type { AnthropicLlmService } from '../../interfaces/llm/anthropic/anthropic-llm.service';
import type { GeoEntityService } from '../../geo-entities/geo-entity.service';
import type { DashboardScoresService } from './dashboard-scores.service';
import type { ScoresResponse } from './dashboard-scores.dto';
import {
  buildMessages,
  finishMessage,
  Placeholders,
  SHARE_MESSAGE_RATE_LIMIT,
  SHARE_MESSAGE_SYSTEM_PROMPT,
  ShareMessageService,
  shareMessageLlm,
} from './share-message.service';

const BLOCK = {
  id: 'b1',
  type: 'block',
  code: '090101',
  name: 'KAKORI',
  has_boundary: false,
  lat: null,
  lng: null,
};
const BEO = {
  id: 'u-beo',
  role: 'education_official',
  geo_entity_id: 'b1',
  external_id: '919000000001',
  geo_type: 'block',
  geo_name: 'KAKORI',
};
const TEACHER = {
  id: 'u-t',
  role: 'education_official',
  geo_entity_id: 's1',
  external_id: '919000000002',
  geo_type: 'school',
  geo_name: 'P.S. GWALPUR',
};

function scoresFor(
  id: string,
  metric: string,
  window?: string,
): ScoresResponse {
  const area = id === 'b1';
  const base = {
    as_of: '2026-10-12',
    metric,
    range: 30,
    entity: area
      ? BLOCK
      : {
          id,
          type: 'teacher',
          code: '',
          name: 'Asha',
          has_boundary: false,
          lat: null,
          lng: null,
        },
    root: {
      pass_rate: 60,
      mean: 0.6,
      sd: 0.1,
      n: 10,
      students_active: 7,
      students_unbanded: 0,
      delta: 5,
    },
    series: [],
    most_improved: [],
  } as unknown as ScoresResponse;
  if (metric === 'usage' && window) {
    return {
      ...base,
      window,
      root: {
        ...base.root,
        time_total: 40,
        time_sum: 400,
        time_per_day: 5.7,
        time_days: 7,
      },
      child_type: area ? 'school' : 'student',
      children: area
        ? [
            {
              id: 's1',
              type: 'school',
              code: '1',
              name: 'P.S. GWALPUR',
              has_boundary: false,
              lat: null,
              lng: null,
              pass_rate: null,
              n: 5,
              students_active: 4,
              using_lifteracy: true,
              delta: 2.1,
              bin: 'high',
              official: null,
              time_total: 60,
              time_sum: 300,
              time_per_day: 8,
              time_days: 7,
            },
            {
              id: 's2',
              type: 'school',
              code: '2',
              name: 'P.S. MAL',
              has_boundary: false,
              lat: null,
              lng: null,
              pass_rate: null,
              n: 5,
              students_active: 3,
              using_lifteracy: true,
              delta: 0.5,
              bin: 'low',
              official: null,
              time_total: 20,
              time_sum: 100,
              time_per_day: 3,
              time_days: 7,
            },
          ]
        : [
            {
              student_id: 'st1',
              label: 'Rani',
              phone: '919999990011',
              name: 'Rani Devi',
              pii: 'full',
              score: 120,
              passed: true,
              attempts: 3,
              in_band: true,
              active: true,
              last_active_at: null,
              delta: 3,
              time_total: 120,
              time_per_day: 17,
              time_days: 7,
            },
            {
              student_id: 'st2',
              label: 'Student 2',
              phone: '919999990022',
              name: null,
              pii: 'full',
              score: 3,
              passed: false,
              attempts: 1,
              in_band: true,
              active: false,
              last_active_at: null,
              delta: 0.5,
              time_total: 3,
              time_per_day: 0.4,
              time_days: 7,
            },
          ],
    } as ScoresResponse;
  }
  if (metric === 'nipun') {
    return {
      ...base,
      root: {
        ...base.root,
        verdict: {
          school_passed: null,
          schools_pass: 1,
          schools_fail: 1,
          schools_insufficient: 2,
        },
      },
      child_type: 'school',
      children: [
        {
          id: 's1',
          type: 'school',
          code: '1',
          name: 'P.S. GWALPUR',
          has_boundary: false,
          lat: null,
          lng: null,
          pass_rate: 100,
          n: 1,
          students_active: 4,
          using_lifteracy: true,
          delta: null,
          bin: 'high',
          official: null,
          verdict: {
            school_passed: true,
            schools_pass: 1,
            schools_fail: 0,
            schools_insufficient: 0,
          },
        },
      ],
    } as ScoresResponse;
  }
  return {
    ...base,
    age_band: [7, 8],
    pass_mark: 75,
    child_type: area ? 'school' : 'student',
    children: area
      ? [
          {
            id: 's1',
            type: 'school',
            code: '1',
            name: 'P.S. GWALPUR',
            has_boundary: false,
            lat: null,
            lng: null,
            pass_rate: 80,
            n: 5,
            students_active: 4,
            using_lifteracy: true,
            delta: 10,
            bin: 'high',
            official: null,
          },
        ]
      : [
          {
            student_id: 'st1',
            label: 'Rani',
            phone: '919999990011',
            name: 'Rani Devi',
            pii: 'full',
            score: 0.75,
            passed: true,
            attempts: 4,
            in_band: true,
            active: true,
            last_active_at: null,
            delta: 25,
          },
        ],
  } as ScoresResponse;
}

function make(
  opts: {
    users?: Record<string, unknown>;
    llmText?: string;
    incr?: number | null;
  } = {},
) {
  const users: Record<string, unknown> = opts.users ?? {
    'u-beo': BEO,
    'u-t': TEACHER,
  };
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('share-message:viewer'))
      return users[params[0] as string] ? [users[params[0] as string]] : [];
    if (sql.includes('share-message:teachers'))
      return [
        {
          id: 'u-t',
          name: 'Asha Kumari',
          school: 'P.S. GWALPUR',
          students: 31,
          new_this_week: 31,
        },
      ];
    if (sql.includes('share-message:class'))
      return [{ students: 12, new_this_week: 2 }];
    throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
  });
  const scores = jest.fn(
    async (id: string, metric: string, _range: unknown, window?: string) =>
      scoresFor(id, metric, window),
  );
  const geo = {
    getById: jest.fn(async (id: string) => (id === 'b1' ? BLOCK : null)),
  };
  const incr = jest.fn(async () => (opts.incr === undefined ? 1 : opts.incr));
  const complete = jest.fn(async () => ({
    text:
      opts.llmText ??
      'शाबाश {{NAME_1}}! {{NAME_2}} और {{NAME_9}} भी। 9876543210\n{{SHARE_LINK}}',
    model: 'claude-haiku-5-5',
    prompt_tokens: 100,
    completion_tokens: 50,
    duration_ms: 900,
  }));
  const svc = new ShareMessageService(
    { query } as unknown as DataSource,
    { scores } as unknown as DashboardScoresService,
    geo as unknown as GeoEntityService,
    { incr } as unknown as CacheService,
    { complete } as unknown as AnthropicLlmService,
    { complete: jest.fn() } as never,
    { complete: jest.fn() } as never,
    { complete: jest.fn() } as never,
  );
  return { svc, query, scores, complete, incr };
}

describe('ShareMessageService — who may ask', () => {
  const OLD = process.env.DASHBOARD_PUBLIC_URL;
  beforeAll(() => {
    process.env.DASHBOARD_PUBLIC_URL = 'https://dash.example';
  });
  afterAll(() => {
    process.env.DASHBOARD_PUBLIC_URL = OLD;
  });

  it('anonymous → 403; a user on another unit → 403; an unknown id → 404', async () => {
    const { svc } = make();
    await expect(svc.generate('b1', ANONYMOUS)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      svc.generate('b1', { kind: 'user', id: 'u-t' }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc.generate('u-t', { kind: 'user', id: 'u-beo' }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc.generate('nope', { kind: 'user', id: 'u-beo' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('a teacher asking for their class and an official for their geo entity pass; staff may ask for any', async () => {
    const { svc } = make();
    expect(
      (await svc.generate('b1', { kind: 'user', id: 'u-beo' })).message,
    ).toBeTruthy();
    expect(
      (await svc.generate('u-t', { kind: 'user', id: 'u-t' })).message,
    ).toBeTruthy();
    expect((await svc.generate('u-t', STAFF)).message).toBeTruthy();
  });

  it('rate limit: the 11th call in a minute is a 429; a Redis outage lets the call through', async () => {
    await expect(
      make({ incr: SHARE_MESSAGE_RATE_LIMIT + 1 }).svc.generate('b1', {
        kind: 'user',
        id: 'u-beo',
      }),
    ).rejects.toThrow(HttpException);
    expect(
      (
        await make({ incr: null }).svc.generate('b1', {
          kind: 'user',
          id: 'u-beo',
        })
      ).message,
    ).toBeTruthy();
    // staff is never limited
    const { svc, incr } = make({ incr: 99 });
    await svc.generate('b1', STAFF);
    expect(incr).not.toHaveBeenCalled();
  });
});

describe('ShareMessageService — what the model sees and what comes back', () => {
  const OLD = process.env.DASHBOARD_PUBLIC_URL;
  beforeAll(() => {
    process.env.DASHBOARD_PUBLIC_URL = 'https://dash.example';
  });
  afterAll(() => {
    process.env.DASHBOARD_PUBLIC_URL = OLD;
  });

  it("an official's block: seven reads over the metrics as STAFF, no names or phones in the prompt, teachers as placeholders, the verdict and the enrolling teacher included", async () => {
    const { svc, scores, complete } = make();
    const out = await svc.generate('b1', { kind: 'user', id: 'u-beo' });
    expect(scores.mock.calls.map((c) => [c[1], c[3]])).toEqual([
      ['usage', '7d'],
      ['usage', 'yesterday'],
      ['nipun_g1', undefined],
      ['nipun_g2', undefined],
      ['nipun_g3', undefined],
      ['mpl_b', undefined],
      ['nipun', undefined],
    ]);
    expect(scores.mock.calls.every((c) => c[4] === STAFF)).toBe(true);
    const req = complete.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
    };
    expect(req.messages[0]).toEqual({
      role: 'system',
      content: SHARE_MESSAGE_SYSTEM_PROMPT,
    });
    const facts = JSON.parse(req.messages[1].content) as Record<
      string,
      unknown
    >;
    const prompt = req.messages[1].content;
    expect(facts.audience).toBe('teachers');
    expect(facts.language).toBe('hi');
    expect(prompt).not.toContain('Asha');
    expect(prompt).not.toContain('919000000');
    expect(prompt).not.toContain('SHARE_LINK');
    expect(facts.teachers).toEqual([
      {
        who: '{{NAME_1}}',
        school: 'P.S. GWALPUR',
        students: 31,
        enrolled_this_week: 31,
      },
    ]);
    expect((facts.nipun_verdict as Record<string, unknown>).passing).toEqual([
      'P.S. GWALPUR',
    ]);
    expect((facts.time_last_7_days as { top: unknown[] }).top[0]).toEqual({
      who: 'P.S. GWALPUR',
      minutes: 300,
      per_student: 60,
      times_the_window_before: 2.1,
    });
    expect(typeof facts.variety_seed).toBe('number');
    expect(complete.mock.calls[0][1]).toEqual({
      maxAttempts: 1,
      timeoutMs: 12_000,
    });
    // the teacher's name is put back, an invented placeholder and the phone number are dropped, no link for teachers
    expect(out.message).toBe('शाबाश Asha Kumari!  और  भी।');
    expect(out.model).toBe('claude-haiku-5-5');
  });

  it("a teacher's class: students as placeholders (first name, else the label), the referral link put back at the end, never the dashboard link", async () => {
    const { svc, scores, complete } = make();
    const out = await svc.generate('u-t', { kind: 'user', id: 'u-t' });
    expect(scores.mock.calls.map((c) => c[1])).toEqual([
      'usage',
      'usage',
      'nipun_g1',
      'nipun_g2',
      'nipun_g3',
      'mpl_b',
    ]);
    const req = complete.mock.calls[0][0] as {
      messages: Array<{ content: string }>;
    };
    const facts = JSON.parse(req.messages[1].content) as Record<
      string,
      unknown
    >;
    expect(facts.audience).toBe('parents');
    expect(facts.share_link).toBe('{{SHARE_LINK}}');
    expect(facts.class).toEqual({
      students: 12,
      enrolled_this_week: 2,
      active_last_14_days: 1,
    });
    expect(req.messages[1].content).not.toContain('Rani');
    expect(req.messages[1].content).not.toContain('dash.example');
    expect((facts.time_last_7_days as { top: unknown[] }).top).toEqual([
      { who: '{{NAME_1}}', minutes: 120, times_the_window_before: 3 },
      { who: '{{NAME_2}}', minutes: 3, times_the_window_before: 0.5 },
    ]);
    expect(out.message).toBe(
      'शाबाश Rani Devi! Student 2 और  भी।\nhttps://dash.example/r/919000000002',
    );
  });

  it('a failing read drops its section, not the message', async () => {
    const { svc, scores, complete } = make();
    scores.mockImplementation(
      async (id: string, metric: string, _r: unknown, window?: string) => {
        if (metric === 'nipun_g2') throw new Error('boom');
        return scoresFor(id, metric, window);
      },
    );
    await svc.generate('b1', { kind: 'user', id: 'u-beo' });
    const facts = JSON.parse(
      (complete.mock.calls[0][0] as { messages: Array<{ content: string }> })
        .messages[1].content,
    ) as { tests: Record<string, unknown> };
    expect(facts.tests.nipun_grade_2).toBeUndefined();
    expect(facts.tests.nipun_grade_3).toBeDefined();
  });
});

describe('share message — pure helpers', () => {
  it('finishMessage: placeholders back, unknown ones dropped, phone-like digit runs removed, the link appended when the model forgot it, length capped', () => {
    const names = new Placeholders();
    expect(names.add('a', 'Asha')).toBe('{{NAME_1}}');
    expect(names.add('a', 'Asha')).toBe('{{NAME_1}}');
    expect(names.add('b', 'Rani')).toBe('{{NAME_2}}');
    expect(
      finishMessage(
        '  {{NAME_1}} {{NAME_2}} {{NAME_3}} 98765 43210  ',
        names.entries,
        null,
      ),
    ).toBe('Asha Rani');
    expect(
      finishMessage('नमस्ते', [], 'https://dash.example/r/919000000002'),
    ).toBe('नमस्ते\nhttps://dash.example/r/919000000002');
    expect(
      finishMessage(
        'लिंक: {{SHARE_LINK}} यहाँ',
        [],
        'https://dash.example/r/919000000002',
      ),
    ).toBe('लिंक: https://dash.example/r/919000000002 यहाँ');
    expect(finishMessage('क'.repeat(2000), [], null)).toHaveLength(1200);
  });

  it('buildMessages: the system prompt asks for Hindi, variety and placeholders; the facts ride as JSON', () => {
    const msgs = buildMessages({
      audience: 'parents',
      language: 'hi',
      as_of: null,
      unit: {},
      tests: {},
      variety_seed: 7,
    });
    expect(msgs[0].content).toContain('Hindi only');
    expect(msgs[0].content).toContain('variety_seed');
    expect(msgs[0].content).toContain('{{SHARE_LINK}}');
    expect(JSON.parse(msgs[1].content)).toMatchObject({
      audience: 'parents',
      variety_seed: 7,
    });
  });

  it('shareMessageLlm: anthropic / claude-haiku-5-5 by default; google refused', () => {
    const old = {
      p: process.env.SHARE_MESSAGE_LLM_PROVIDER,
      m: process.env.SHARE_MESSAGE_LLM_MODEL,
    };
    delete process.env.SHARE_MESSAGE_LLM_PROVIDER;
    delete process.env.SHARE_MESSAGE_LLM_MODEL;
    expect(shareMessageLlm()).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
    });
    process.env.SHARE_MESSAGE_LLM_PROVIDER = 'sarvam';
    process.env.SHARE_MESSAGE_LLM_MODEL = 'sarvam-105b';
    expect(shareMessageLlm()).toEqual({
      provider: 'sarvam',
      model: 'sarvam-105b',
    });
    process.env.SHARE_MESSAGE_LLM_PROVIDER = 'google';
    expect(() => shareMessageLlm()).toThrow(/reserved/);
    if (old.p === undefined) delete process.env.SHARE_MESSAGE_LLM_PROVIDER;
    else process.env.SHARE_MESSAGE_LLM_PROVIDER = old.p;
    if (old.m === undefined) delete process.env.SHARE_MESSAGE_LLM_MODEL;
    else process.env.SHARE_MESSAGE_LLM_MODEL = old.m;
  });
});
