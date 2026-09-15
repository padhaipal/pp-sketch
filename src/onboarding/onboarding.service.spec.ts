process.env.DASHBOARD_PUBLIC_URL = 'https://dashboard.padhaipal.com';
process.env.ONBOARDING_LLM_PROVIDER = 'openai';
process.env.ONBOARDING_LLM_MODEL = 'test-classifier';
// onboardingLlm() asserts the provider's key at read time (boot check).
process.env.OPENAI_API_KEY = 'test-key';

// ESM-only package; UserService imports it (see user.service.spec.ts).
jest.mock('uuid', () => ({
  validate: jest.fn(() => false),
  v4: jest.fn(() => 'uuid-mock'),
}));

import { Logger } from '@nestjs/common';
import { createActor } from 'xstate';
import type { DataSource } from 'typeorm';
import {
  OnboardingService,
  istYear,
  normalizeClassification,
  matchTranscripts,
  referralText,
  transcriptsMessage,
} from './onboarding.service';
import {
  machine,
  MAX_AGE,
  MIN_AGE,
  ONBOARDING_STIDS,
  UNINTELLIGIBLE,
  NONE,
  type OnboardingStateName,
} from './onboarding.machine';

const user = {
  id: 'u1',
  external_id: '+919999990001',
  role: null,
  created_at: new Date('2026-09-20T00:00:00Z'),
  birth_year: null,
  birth_month: null,
  recording_permissions_obtained_at: null,
} as any;

const transcripts = [
  { id: 't1', text: 'हाँ जी' },
  { id: 't2', text: 'haan ji' },
] as any[];

// A persisted snapshot at the named state, produced by the real machine.
const PATH_TO: Record<Exclude<OnboardingStateName, 'done'>, string[]> = {
  askGuardian: [],
  askConsent: ['YES'],
  consentRefused: ['YES', 'NO'],
  declined: ['YES', 'NO', 'NO'],
  askName: ['YES', 'YES'],
  askAge: ['YES', 'YES', 'राम'],
  askMonth: ['YES', 'YES', 'राम', '8'],
};
function snapshotAt(
  state: OnboardingStateName,
  opts: { name?: string | null } = {},
): Record<string, unknown> {
  const actor = createActor(machine);
  actor.start();
  const path =
    state === 'done'
      ? [
          'YES',
          'YES',
          opts.name === null ? NONE : (opts.name ?? 'राम'),
          '8',
          '3',
        ]
      : PATH_TO[state].map((v, i) =>
          i === 2 && opts.name !== undefined ? (opts.name ?? NONE) : v,
        );
  for (const value of path) {
    actor.send({ type: 'REPLY', value, istYear: 2026 });
  }
  const snapshot = JSON.parse(
    JSON.stringify(actor.getPersistedSnapshot()),
  ) as Record<string, unknown>;
  actor.stop();
  return snapshot;
}

function makeMocks(opts: { row?: Record<string, unknown> | null } = {}) {
  const managerQuery = jest.fn().mockResolvedValue(undefined);
  const manager = { query: managerQuery };
  const dsQuery = jest.fn(async (sql: string) => {
    if (/SELECT user_id, snapshot FROM onboarding_states/.test(sql)) {
      return opts.row ? [{ user_id: user.id, snapshot: opts.row }] : [];
    }
    return [];
  });
  const transaction = jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
    cb(manager),
  );
  const dataSource = { query: dsQuery, transaction } as unknown as DataSource;
  const userService = {
    update: jest.fn().mockResolvedValue({}),
    invalidateCache: jest.fn().mockResolvedValue(undefined),
  };
  const literacyLessonService = {
    processAnswer: jest.fn().mockResolvedValue({
      stateTransitionIds: ['ल-start-word-initial'],
      isComplete: false,
    }),
    cleanupPartialState: jest.fn().mockResolvedValue(undefined),
  };
  const complete = jest.fn().mockResolvedValue({
    text: 'yes',
    model: 'test-classifier',
    prompt_tokens: 1,
    completion_tokens: 1,
    duration_ms: 12,
  });
  const llm = { complete };
  const svc = new OnboardingService(
    dataSource,
    userService as any,
    literacyLessonService as any,
    llm as any,
    llm as any,
    llm as any,
    llm as any,
    llm as any,
  );
  return {
    svc,
    dsQuery,
    transaction,
    manager,
    managerQuery,
    userService,
    literacyLessonService,
    complete,
  };
}

function insertedSnapshot(managerQuery: jest.Mock): any {
  const call = managerQuery.mock.calls.find(([sql]) =>
    /INSERT INTO onboarding_states/.test(String(sql)),
  );
  expect(call).toBeDefined();
  return JSON.parse(String(call![1][2]));
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
beforeEach(() => {
  logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('OnboardingService.handleTurn — first turn as start', () => {
  it('inserts the initial askGuardian row and returns its prompt without classifying', async () => {
    const m = makeMocks({ row: null });
    const out = await m.svc.handleTurn({ user, user_message_id: 'msg-1' });

    expect(out).toEqual({
      stateTransitionIds: [ONBOARDING_STIDS.askGuardian],
      texts: [],
    });
    expect(m.complete).not.toHaveBeenCalled();
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.managerQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = m.managerQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO onboarding_states/);
    expect(params.slice(0, 2)).toEqual(['u1', 'msg-1']);
    expect(insertedSnapshot(m.managerQuery).value).toBe('askGuardian');
    expect(m.userService.update).not.toHaveBeenCalled();
  });

  it('restarts from askGuardian (logging an error) when the newest row fails to restore', async () => {
    const m = makeMocks({
      row: { status: 'active', value: 'noSuchState', context: 42 },
    });
    const out = await m.svc.handleTurn({
      user,
      transcripts,
      user_message_id: 'msg-2',
    });
    expect(out.stateTransitionIds).toEqual([ONBOARDING_STIDS.askGuardian]);
    expect(m.complete).not.toHaveBeenCalled();
    expect(insertedSnapshot(m.managerQuery).value).toBe('askGuardian');
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /restore failed for user u1/,
    );
  });
});

describe('OnboardingService.handleTurn — classifying turns', () => {
  it('classifies for the current state, runs the machine and appends the new row', async () => {
    const m = makeMocks({ row: snapshotAt('askGuardian') });
    m.complete.mockResolvedValue({ text: 'Yes.', duration_ms: 5 });

    const out = await m.svc.handleTurn({
      user,
      transcripts,
      user_message_id: 'msg-3',
    });

    expect(out).toEqual({
      stateTransitionIds: [ONBOARDING_STIDS.askConsent],
      texts: [],
    });
    const request = m.complete.mock.calls[0][0];
    expect(request.messages[0].content).toMatch(
      /^A parent on WhatsApp was asked whether they are this child's parent or guardian\./,
    );
    expect(request.messages[1].content).toBe(
      transcriptsMessage(['हाँ जी', 'haan ji']),
    );
    expect(insertedSnapshot(m.managerQuery).value).toBe('askConsent');
    expect(m.userService.update).not.toHaveBeenCalled();
    expect(m.userService.invalidateCache).not.toHaveBeenCalled();
    expect(m.literacyLessonService.processAnswer).not.toHaveBeenCalled();
  });

  it('skips classification in a kind:none state (declined → askConsent)', async () => {
    const m = makeMocks({ row: snapshotAt('declined') });
    const out = await m.svc.handleTurn({
      user,
      transcripts,
      user_message_id: 'msg-4',
    });
    expect(m.complete).not.toHaveBeenCalled();
    expect(out.stateTransitionIds).toEqual([ONBOARDING_STIDS.askConsent]);
    expect(insertedSnapshot(m.managerQuery).value).toBe('askConsent');
  });

  it('a clear spoken age skips the LLM and advances', async () => {
    const m = makeMocks({ row: snapshotAt('askAge') });
    const out = await m.svc.handleTurn({
      user,
      transcripts: [
        { id: 't1', text: 'आठ साल' },
        { id: 't2', text: '8 साल' },
      ] as any[],
      user_message_id: 'msg-5a',
    });
    expect(m.complete).not.toHaveBeenCalled();
    expect(out.stateTransitionIds).toEqual([ONBOARDING_STIDS.askMonth]);
    expect(insertedSnapshot(m.managerQuery).context.birthYear).toBe(
      istYear() - 8,
    );
  });

  it('an unintelligible reply re-asks without advancing', async () => {
    const m = makeMocks({ row: snapshotAt('askAge') });
    m.complete.mockResolvedValue({ text: 'I am not sure', duration_ms: 5 });
    const out = await m.svc.handleTurn({
      user,
      transcripts,
      user_message_id: 'msg-5',
    });
    expect(out.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.unintelligible,
      ONBOARDING_STIDS.askAge,
    ]);
    expect(insertedSnapshot(m.managerQuery).value).toBe('askAge');
  });

  it('a done row (lost cache eviction) re-evicts and re-sends the completion media without inserting', async () => {
    const m = makeMocks({ row: snapshotAt('done') });
    const out = await m.svc.handleTurn({
      user,
      transcripts,
      user_message_id: 'msg-6',
    });
    expect(out).toEqual({
      stateTransitionIds: [ONBOARDING_STIDS.complete],
      texts: [],
    });
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.userService.invalidateCache).toHaveBeenCalledWith(user);
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('propagates a classifier failure (the job retries the whole turn)', async () => {
    const m = makeMocks({ row: snapshotAt('askGuardian') });
    m.complete.mockRejectedValue(new Error('openai timed out after 5000 ms'));
    await expect(
      m.svc.handleTurn({ user, transcripts, user_message_id: 'msg-7' }),
    ).rejects.toThrow(/timed out/);
    expect(m.transaction).not.toHaveBeenCalled();
  });
});

describe('OnboardingService.handleTurn — done state', () => {
  it('writes the user columns through the transaction manager, then kicks off lesson one', async () => {
    const m = makeMocks({ row: snapshotAt('askMonth') });
    m.complete.mockResolvedValue({ text: '3', duration_ms: 5 });
    m.literacyLessonService.processAnswer.mockResolvedValue({
      stateTransitionIds: ['sentence-start-sentence-initial'],
      isComplete: false,
      sentenceText: 'राम घर जाता है।',
    });
    const before = Date.now();

    const out = await m.svc.handleTurn({
      user,
      transcripts,
      user_message_id: 'msg-8',
    });

    // Row + user write share the transaction.
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(insertedSnapshot(m.managerQuery).status).toBe('done');
    expect(m.userService.update).toHaveBeenCalledTimes(1);
    const [fields, manager] = m.userService.update.mock.calls[0];
    expect(manager).toBe(m.manager);
    expect(fields).toEqual({
      id: 'u1',
      new_birth_year: 2026 - 8,
      new_birth_month: 3,
      new_recording_permissions_obtained_at: expect.any(Date),
      new_name: 'राम',
    });
    expect(
      (fields.new_recording_permissions_obtained_at as Date).getTime(),
    ).toBeGreaterThanOrEqual(before);

    // Post-commit: cache eviction, then referral + lesson one.
    expect(m.userService.invalidateCache).toHaveBeenCalledWith(user);
    expect(
      m.userService.invalidateCache.mock.invocationCallOrder[0],
    ).toBeGreaterThan(m.transaction.mock.invocationCallOrder[0]);
    expect(m.literacyLessonService.processAnswer).toHaveBeenCalledWith({
      user,
      user_message_id: 'msg-8',
    });
    expect(out).toEqual({
      stateTransitionIds: [
        ONBOARDING_STIDS.complete,
        'sentence-start-sentence-initial',
      ],
      texts: [referralText('+919999990001'), 'राम घर जाता है।'],
    });
  });

  it('omits new_name when no name was extracted', async () => {
    const m = makeMocks({ row: snapshotAt('askMonth', { name: null }) });
    m.complete.mockResolvedValue({ text: 'NONE', duration_ms: 5 });
    await m.svc.handleTurn({ user, transcripts, user_message_id: 'msg-9' });
    const [fields] = m.userService.update.mock.calls[0];
    expect(fields).toEqual({
      id: 'u1',
      new_birth_year: 2026 - 8,
      new_birth_month: null,
      new_recording_permissions_obtained_at: expect.any(Date),
    });
    expect('new_name' in fields).toBe(false);
  });

  it('is atomic: a failing user write aborts the turn — no cache eviction, no lesson', async () => {
    const m = makeMocks({ row: snapshotAt('askMonth') });
    m.complete.mockResolvedValue({ text: '3', duration_ms: 5 });
    m.userService.update.mockRejectedValue(new Error('db down'));
    await expect(
      m.svc.handleTurn({ user, transcripts, user_message_id: 'msg-10' }),
    ).rejects.toThrow('db down');
    // The transaction callback saw the INSERT and the failed update; the
    // real DataSource rolls both back together.
    expect(m.managerQuery).toHaveBeenCalledTimes(1);
    expect(m.userService.invalidateCache).not.toHaveBeenCalled();
    expect(m.literacyLessonService.processAnswer).not.toHaveBeenCalled();
  });
});

describe('OnboardingService.rollback', () => {
  it('deletes the row for the message and does nothing else for a non-done turn', async () => {
    const m = makeMocks();
    m.dsQuery.mockResolvedValue([
      { user_id: 'u1', snapshot: snapshotAt('askAge') },
    ]);
    await m.svc.rollback('msg-1');
    expect(m.dsQuery).toHaveBeenCalledWith(
      expect.stringMatching(
        /DELETE FROM onboarding_states WHERE user_message_id = \$1\s+RETURNING user_id, snapshot/,
      ),
      ['msg-1'],
    );
    expect(m.userService.update).not.toHaveBeenCalled();
    expect(m.literacyLessonService.cleanupPartialState).not.toHaveBeenCalled();
  });

  it('a done row also resets the user columns (name untouched) and cleans lesson-one rows', async () => {
    const m = makeMocks();
    m.dsQuery.mockResolvedValue([
      { user_id: 'u1', snapshot: snapshotAt('done') },
    ]);
    await m.svc.rollback('msg-2');
    expect(m.userService.update).toHaveBeenCalledWith({
      id: 'u1',
      new_birth_year: null,
      new_birth_month: null,
      new_recording_permissions_obtained_at: null,
    });
    expect(m.literacyLessonService.cleanupPartialState).toHaveBeenCalledWith(
      'msg-2',
    );
  });

  it('is a no-op when no row exists', async () => {
    const m = makeMocks();
    m.dsQuery.mockResolvedValue([]);
    await expect(m.svc.rollback('msg-3')).resolves.toBeUndefined();
    expect(m.userService.update).not.toHaveBeenCalled();
  });
});

describe('OnboardingService.classify', () => {
  const age = { kind: 'integer', min: MIN_AGE, max: MAX_AGE } as const;

  it('makes one bounded, temperature-0 call with the state prompt and every transcript', async () => {
    const m = makeMocks();
    m.complete.mockResolvedValue({ text: ' 7 ', duration_ms: 5 });
    const value = await m.svc.classify(transcripts, age, 'askAge', 'PROMPT');
    expect(value).toBe('7');
    expect(m.complete).toHaveBeenCalledTimes(1);
    const [request, options] = m.complete.mock.calls[0];
    expect(request).toEqual({
      model: 'test-classifier',
      messages: [
        { role: 'system', content: 'PROMPT' },
        { role: 'user', content: transcriptsMessage(['हाँ जी', 'haan ji']) },
      ],
      temperatureRatio: 0,
      max_tokens: 200,
    });
    expect(options).toEqual({ timeoutMs: 5000, maxAttempts: 1 });
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /onboarding\.classify\.result state=askAge kind=integer method=llm outcome=7 provider=openai/,
    );
  });

  it.each([
    [age, ['आठ', 'aath'], '8'],
    [{ kind: 'month' } as const, ['मार्च में', 'March'], '3'],
  ])(
    '%j: a clear match in %j returns %s without calling the LLM',
    async (interpret, texts, expected) => {
      const m = makeMocks();
      const value = await m.svc.classify(
        texts.map((text, i) => ({ id: `t${i}`, text })) as any[],
        interpret,
        'state',
        'PROMPT',
      );
      expect(value).toBe(expected);
      expect(m.complete).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
        new RegExp(`method=match outcome=${expected}`),
      );
    },
  );

  it('falls back to the LLM when the transcripts disagree', async () => {
    const m = makeMocks();
    m.complete.mockResolvedValue({ text: 'eight', duration_ms: 5 });
    const value = await m.svc.classify(
      [
        { id: 't1', text: 'आठ' },
        { id: 't2', text: 'नौ' },
      ] as any[],
      age,
      'askAge',
      'PROMPT',
    );
    expect(m.complete).toHaveBeenCalledTimes(1);
    expect(value).toBe('8');
  });

  it('logs only whether a name was found, never the name', async () => {
    const m = makeMocks();
    m.complete.mockResolvedValue({ text: 'सीता', duration_ms: 5 });
    await m.svc.classify(transcripts, { kind: 'name' }, 'askName', 'PROMPT');
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/kind=name method=llm outcome=name/);
    expect(logged).not.toMatch(/सीता/);
  });

  it('refuses the sarvam provider', async () => {
    const prev = process.env.ONBOARDING_LLM_PROVIDER;
    process.env.ONBOARDING_LLM_PROVIDER = 'sarvam';
    try {
      const m = makeMocks();
      await expect(
        m.svc.classify(transcripts, { kind: 'month' }, 'askMonth', 'PROMPT'),
      ).rejects.toThrow(/sarvam is not supported/);
      expect(m.complete).not.toHaveBeenCalled();
    } finally {
      process.env.ONBOARDING_LLM_PROVIDER = prev;
    }
  });

  it('fails when ONBOARDING_LLM_MODEL is unset', async () => {
    const prev = process.env.ONBOARDING_LLM_MODEL;
    delete process.env.ONBOARDING_LLM_MODEL;
    try {
      const m = makeMocks();
      await expect(
        m.svc.classify(transcripts, { kind: 'month' }, 'askMonth', 'PROMPT'),
      ).rejects.toThrow(/ONBOARDING_LLM_MODEL must be set/);
    } finally {
      process.env.ONBOARDING_LLM_MODEL = prev;
    }
  });
});

describe('transcriptsMessage / matchTranscripts', () => {
  it('lists transcripts without numbered labels', () => {
    const message = transcriptsMessage(['आठ', 'eight']);
    expect(message.split('\n').slice(1)).toEqual(['- आठ', '- eight']);
    expect(message).not.toMatch(/\d/);
  });

  it('matches only age and month questions', () => {
    expect(
      matchTranscripts(['8'], { kind: 'integer', min: 0, max: 1000 }),
    ).toBe('8');
    expect(matchTranscripts(['मई'], { kind: 'month' })).toBe('5');
    expect(
      matchTranscripts(['yes'], { kind: 'enum', options: ['yes', 'no'] }),
    ).toBeNull();
    expect(matchTranscripts(['राम'], { kind: 'name' })).toBeNull();
    expect(
      matchTranscripts(['कुछ नहीं'], { kind: 'integer', min: 0, max: 1000 }),
    ).toBeNull();
  });
});

describe('normalizeClassification', () => {
  const yesNoInfo = {
    kind: 'enum',
    options: ['yes', 'no', 'information'],
  } as const;

  it.each([
    ['yes', 'YES'],
    ['  No.', 'NO'],
    ['"information"', 'INFORMATION'],
    // Whole-word match inside a prefix/suffix.
    ['The answer is yes', 'YES'],
    ['yes.', 'YES'],
    ['yes, definitely', 'YES'],
    ['Information, please', 'INFORMATION'],
    // Repeated single option is one match; two distinct options is a guess.
    ['yes yes', 'YES'],
    ['No, yes', UNINTELLIGIBLE],
    ['yes and no', UNINTELLIGIBLE],
    // Substrings are not words: "nobody" / "NONE" never mean no.
    ['nobody knows', UNINTELLIGIBLE],
    ['NONE', UNINTELLIGIBLE],
    ['UNINTELLIGIBLE', UNINTELLIGIBLE],
    ['maybe', UNINTELLIGIBLE],
    ['', UNINTELLIGIBLE],
  ])('enum: %j → %s', (text, expected) => {
    expect(normalizeClassification(text, yesNoInfo)).toBe(expected);
  });

  it.each([
    ['8', '8'],
    ['08.', '8'],
    [' 12 ', '12'],
    ['150', '150'],
    ['0', '0'],
    ['1000', '1000'],
    // A prefix, suffix or number word is read, never trusted to be digits.
    ['I think 8', '8'],
    ['8 years', '8'],
    ['Age: eight', '8'],
    ['आठ', '8'],
    ['वह सात साल की है', '7'],
    ['एक सौ पाँच', '105'],
    ['८', '8'],
    // Out of range or two candidates.
    ['1001', UNINTELLIGIBLE],
    ['7 or 8', UNINTELLIGIBLE],
    ['7.5', UNINTELLIGIBLE],
    ['UNINTELLIGIBLE', UNINTELLIGIBLE],
    ['', UNINTELLIGIBLE],
  ])('integer: %j → %s', (text, expected) => {
    expect(
      normalizeClassification(text, {
        kind: 'integer',
        min: MIN_AGE,
        max: MAX_AGE,
      }),
    ).toBe(expected);
  });

  it.each([
    ['1', '1'],
    ['12.', '12'],
    ['Month 7', '7'],
    ['८', '8'],
    ['March', '3'],
    ['March (3)', '3'],
    ['मार्च', '3'],
    ['twelve', '12'],
    ['0', NONE],
    ['13', NONE],
    ['3 or 4', NONE],
    ['April or May', NONE],
    ['NONE', NONE],
  ])('month: %j → %s', (text, expected) => {
    expect(normalizeClassification(text, { kind: 'month' })).toBe(expected);
  });

  it.each([
    ['सीता', 'सीता'],
    ['"Ram Kumar".', 'Ram Kumar'],
    ['Name: सीता', 'सीता'],
    ['NONE', NONE],
    ['none', NONE],
    ['UNINTELLIGIBLE', NONE],
    ['', NONE],
    ['a\nb', NONE],
    ['x'.repeat(61), NONE],
  ])('name: %j → %s', (text, expected) => {
    expect(normalizeClassification(text, { kind: 'name' })).toBe(expected);
  });

  it('none: anything → ANY', () => {
    expect(normalizeClassification('whatever', { kind: 'none' })).toBe('ANY');
  });
});

describe('helpers', () => {
  it('istYear uses the Asia/Kolkata calendar', () => {
    // 2026-12-31T20:00Z is already 2027-01-01 01:30 IST.
    expect(istYear(new Date('2026-12-31T20:00:00Z'))).toBe(2027);
    expect(istYear(new Date('2026-12-31T18:00:00Z'))).toBe(2026);
  });

  it('referralText carries the dashboard referral URL', () => {
    expect(referralText('+911234567890')).toBe(
      'PadhaiPal अपने दोस्तों के साथ शेयर करें बस उन्हें यह लिंक भेजें। https://dashboard.padhaipal.com/r/+911234567890',
    );
  });
});
