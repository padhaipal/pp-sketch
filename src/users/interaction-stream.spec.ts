// uuid is ESM-only — transitively imported via UserModule → UserService.
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'gen-uuid'),
  validate: () => true,
}));
jest.mock('bcrypt', () => ({ compare: jest.fn(), hash: jest.fn() }));

import {
  displayedAnswer,
  pickTranscript,
  rowKey,
  STAND_IN_NAMES,
  studentInitials,
  toStreamRow,
  wpmOf,
  type InteractionSourceRow,
} from './interaction-stream';
import { InteractionStreamService } from './interaction-stream.service';
import type { CacheService } from '../interfaces/redis/cache';
import type { DataSource } from 'typeorm';
import { UserModule } from './user.module';
import { UserController } from './user.controller';

process.env.ONBOARDING_CUTOFF ??= '2026-01-01T00:00:00Z';

const voice = (
  o: Partial<InteractionSourceRow> = {},
): InteractionSourceRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  user_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  created_at: new Date('2026-10-22T13:00:00Z'),
  media_type: 'audio',
  duration_ms: null,
  student_name: 'Rani Kumari',
  lesson_word: 'कमल',
  lesson_answer_correct: true,
  prev_word: null,
  prev_answer: null,
  tap_between: false,
  tap_chosen: null,
  tap_chosen_correct: null,
  tap_correct: null,
  transcripts: [{ source: 'sarvam', text: 'कमल' }],
  ...o,
});

describe('interaction stream rows', () => {
  it('masks the name and the transcript to first and last character', () => {
    const row = toStreamRow(voice());
    expect(row.student).toBe('R...i');
    expect(row.answer).toBe('क...ल');
    expect(row.kind).toBe('voice');
    expect(row.at).toBe('2026-10-22T13:00:00.000Z');
  });

  it('never exposes ids: the key is a stable hash', () => {
    const row = toStreamRow(voice());
    expect(row.key).toBe(rowKey('11111111-1111-4111-8111-111111111111'));
    expect(row.key).toHaveLength(16);
    expect(JSON.stringify(row)).not.toContain('11111111');
  });

  it('censors before masking: a leading phone number is not shown', () => {
    const row = toStreamRow(
      voice({ transcripts: [{ source: 'sarvam', text: '9876543210 कमल' }] }),
    );
    expect(row.answer).toBe('[...ल');
  });

  it('an unnamed student is a masked common Indian name, stable per student', () => {
    const a = toStreamRow(voice({ student_name: null })).student;
    const real = new Set(STAND_IN_NAMES.map((n) => `${n[0]}...${n.at(-1)}`));
    expect(real.has(a)).toBe(true);
    expect(toStreamRow(voice({ student_name: '  ' })).student).toBe(a);
    expect(
      toStreamRow(voice({ student_name: null, user_id: 'other' })).student,
    ).not.toBe(a);
    expect(a).toBe(studentInitials('aaaaaaaa-0000-4000-8000-000000000001'));
  });

  it('picks transcripts sarvam → azure → bodhan, skipping empty ones', () => {
    expect(
      pickTranscript([
        { source: 'bodhan', text: 'b' },
        { source: 'sarvam', text: '  ' },
        { source: 'azure', text: 'a' },
      ]),
    ).toBe('a');
    expect(pickTranscript(null)).toBeNull();
    expect(toStreamRow(voice({ transcripts: null })).answer).toBeNull();
  });

  it('expected answer: the word on a new word, else the previous turn’s answer', () => {
    expect(displayedAnswer(voice())).toBe('कमल');
    expect(displayedAnswer(voice({ prev_word: 'कमल', prev_answer: 'क' }))).toBe(
      'क',
    );
    expect(displayedAnswer(voice({ prev_word: 'घर', prev_answer: 'घ' }))).toBe(
      'कमल',
    );
    expect(
      displayedAnswer(
        voice({ prev_word: 'कमल', prev_answer: 'क', tap_between: true }),
      ),
    ).toBe('कमल');
    expect(displayedAnswer(voice({ lesson_word: null }))).toBeNull();
  });

  it('wpm only for passage reads with a measured length', () => {
    expect(
      wpmOf(voice({ lesson_word: 'एक दो तीन चार', duration_ms: '6000' })),
    ).toBe(40);
    expect(wpmOf(voice({ duration_ms: 6000 }))).toBeNull(); // one word
    expect(
      wpmOf(voice({ lesson_word: 'एक दो', duration_ms: null })),
    ).toBeNull();
  });

  it('a tap shows the chosen and the correct option in full', () => {
    const row = toStreamRow(
      voice({
        media_type: 'text',
        tap_chosen: 'नदी में',
        tap_chosen_correct: false,
        tap_correct: 'पेड़ पर',
        lesson_answer_correct: null,
        transcripts: null,
      }),
    );
    expect(row).toEqual(
      expect.objectContaining({
        kind: 'tap',
        answer: 'नदी में',
        correct_answer: 'पेड़ पर',
        answer_correct: false,
        wpm: null,
      }),
    );
  });
});

function make(cached: unknown = null) {
  const query = jest.fn(async () => [voice()]);
  const cache = {
    get: jest.fn().mockResolvedValue(cached),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new InteractionStreamService(
    { query } as unknown as DataSource,
    cache as unknown as CacheService,
  );
  return { svc, query, cache };
}

describe('InteractionStreamService', () => {
  it('a cache hit skips the database', async () => {
    const { svc, query } = make({ rows: [] });
    expect(await svc.get()).toEqual({ rows: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('a miss queries once (2 min delay, 20 rows) and caches for 45 s', async () => {
    const { svc, query, cache } = make();
    const out = await svc.get();
    expect(out.delay_s).toBe(120);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].student).toBe('R...i');
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('interaction-stream:rows');
    expect(params[0]).toBe(120);
    expect(params[3]).toBe(20);
    expect(cache.set).toHaveBeenCalledWith(
      'dashboard:interactions:v1',
      out,
      45,
    );
  });

  it('concurrent misses share one query', async () => {
    const { svc, query } = make();
    await Promise.all([svc.get(), svc.get(), svc.get()]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('is provided by UserModule and served by UserController', () => {
    const providers = Reflect.getMetadata('providers', UserModule) as unknown[];
    expect(providers).toContain(InteractionStreamService);
    const paths = Object.getOwnPropertyNames(UserController.prototype).map(
      (m) =>
        Reflect.getMetadata(
          'path',
          (UserController.prototype as unknown as Record<string, object>)[m],
        ) as unknown,
    );
    expect(paths).toContain('dashboard/interactions');
  });
});
