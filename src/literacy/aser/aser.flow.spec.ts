// ASER delivered through the REAL lesson machine + LiteracyLessonService +
// AserService over an in-memory fake of the SQL they run (dispatched on the
// query text). Only the DB, the score service and the tracer are faked.

// uuid is ESM-only — transitively imported via UserService.
jest.mock('uuid', () => ({ v4: jest.fn(() => 'gen-uuid') }));
jest.mock('../../otel/otel', () => ({
  tracer: {
    startActiveSpan: async (_n: string, cb: (span: unknown) => unknown) =>
      cb({
        setAttribute: jest.fn(),
        setStatus: jest.fn(),
        recordException: jest.fn(),
        end: jest.fn(),
      }),
  },
}));

import type { DataSource, Repository } from 'typeorm';
import { LiteracyLessonService } from '../literacy-lesson/literacy-lesson.service';
import type { LiteracyLessonStateEntity } from '../literacy-lesson/literacy-lesson-state.entity';
import type { ScoreService } from '../score/score.service';
import { AserService } from './aser.service';
import type { AserState } from './aser';

interface Row {
  user_message_id: string;
  word: string | null;
  snapshot: {
    status: string;
    value: string;
    context: Record<string, unknown> & { aser?: AserState | null };
  };
  level: number | null;
  passage_id: string | null;
  created_at: Date;
}

const P9 = [
  {
    id: '00000000-0000-4000-8000-000000000091',
    text: 'जय घर गया। नल है।',
    level: 9,
  },
  {
    id: '00000000-0000-4000-8000-000000000092',
    text: 'बादल आया। पानी गिरा।',
    level: 9,
  },
];
const P10 = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    text: 'नदी बहती है। मछली तैरती है।',
    level: 10,
  },
];

function makeWorld(due: Record<string, unknown>) {
  const rows: Row[] = [];
  const normalSelections: number[] = [];
  let n = 0;
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO literacy_lesson_states')) {
      const row: Row = {
        user_message_id: params[1] as string,
        word: params[2] as string,
        snapshot: JSON.parse(params[5] as string) as Row['snapshot'],
        level: params[6] as number | null,
        passage_id: params[7] as string | null,
        created_at: new Date(),
      };
      rows.push(row);
      return [row];
    }
    if (sql.includes('WITH aser AS')) return [due];
    if (sql.includes('ORDER BY EXISTS')) {
      const [, level, used] = params as [string, number, string[]];
      return [...P9, ...P10].filter(
        (p) => p.level === level && !used.includes(p.id),
      );
    }
    if (sql.includes('recent_distinct_words')) {
      return [
        {
          letter_scores: [],
          recent_words: [],
          unique_in_add_window: 0,
          unique_in_keep_window: 0,
          unique_in_boost_window: 0,
          recent_row_count: 0,
          distinct_word_count: 0,
          prev_level: null,
          recent_turns: [],
          lifetime_done_count: 0,
          recent_passage_ids: [],
          has_aser_placement: rows.some(
            (r) => r.snapshot.context.aser?.placementLevel != null,
          ),
        },
      ];
    }
    if (sql.includes("media_details->>'role' = 'passage'")) {
      // normal selectPassage (first call per selection: exact level)
      normalSelections.push(params[0] as number);
      return [{ id: P9[0].id, text: P9[0].text, level: params[0] }];
    }
    if (sql.includes('JOIN media_metadata q')) {
      return [{ id: params[0], media_details: { correct: true } }];
    }
    if (sql.includes('SELECT text FROM media_metadata')) {
      const p = [...P9, ...P10].find((x) => x.id === params[0]);
      return p ? [{ text: p.text }] : [];
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  });
  const ds = { query } as unknown as DataSource;
  const repo = {
    findOne: jest.fn(async () => rows[rows.length - 1] ?? null),
  } as unknown as Repository<LiteracyLessonStateEntity>;
  const score = {
    gradeAndRecord: jest.fn().mockResolvedValue({ scores: [], floored: [] }),
  } as unknown as ScoreService;
  const svc = new LiteracyLessonService(repo, ds, score, new AserService(ds));
  const user = { id: 'u1', external_id: '+910000000001' } as never;
  const say = (text: string) =>
    svc.processAnswer({
      user,
      user_message_id: `mm-${++n}`,
      transcripts: [{ id: `t-${n}`, text } as never],
      audio_duration_ms: 1_000,
    });
  const next = () => svc.processAnswer({ user, user_message_id: `mm-${++n}` });
  const tap = () =>
    svc.processAnswer({
      user,
      user_message_id: `mm-${++n}`,
      comprehension_answer_id: 'opt-1',
    });
  const last = () => rows[rows.length - 1];
  const aser = () => last().snapshot.context.aser as AserState;
  return { rows, say, next, tap, last, aser, normalSelections, score, query };
}

const ONBOARDING = {
  has_lessons: false,
  last_run: null,
  last_milestone: null,
  story_passed: false,
  mpl_b_passed: false,
  active_ms: 0,
  bank_history: null,
  lesson_level: null,
};

describe('ASER delivered through the lesson loop', () => {
  it('onboarding test: 2 words right → paragraph → story failed → placed at level 9', async () => {
    const w = makeWorld(ONBOARDING);

    // first lesson ever → ASER run 1, a word item with its normal prompt
    let out = await w.next();
    const first = w.last().snapshot.context.word as string;
    expect(out.stateTransitionIds).toEqual([`${first}-start-word-initial`]);
    expect(w.aser()).toMatchObject({ run: 1, milestone: 0, stage: 'word' });
    expect(w.last().level).toBeNull(); // ASER rows carry no level

    // two words read right
    for (let i = 0; i < 2; i++) {
      const word = w.last().snapshot.context.word as string;
      out = await w.say(word);
      expect(out.isComplete).toBe(true);
      if (i === 0) {
        out = await w.next();
        expect(w.aser().stage).toBe('word');
      }
    }
    expect(w.aser().stage).toBe('paragraph');
    expect(w.aser().counts.word).toEqual({ correct: 2, incorrect: 0 });

    // paragraph: a level-9 passage, read right first time → comprehension
    out = await w.next();
    expect(w.last().snapshot.value).toBe('sentence');
    expect(out.sentenceText).toBeDefined();
    const p = P9.find((x) => x.id === w.last().passage_id)!;
    out = await w.say(p.text.replace(/।/g, ''));
    expect(w.last().snapshot.value).toBe('comprehension');
    expect(out.completedReading).toEqual({
      wordCount: p.text.split(/[\s।]+/).filter(Boolean).length,
      level: 9,
    });
    expect(w.aser().outcomes.paragraph).toBe('passed');
    expect(w.aser().stage).toBe('story');
    // the comprehension question still runs (NIPUN), aser carried through
    out = await w.tap();
    expect(out.isComplete).toBe(true);
    expect(w.aser().stage).toBe('story');

    // story: level 10, read wrong → test over on that answer
    out = await w.next();
    expect(w.last().passage_id).toBe(P10[0].id);
    out = await w.say('कुछ भी नहीं');
    // no ASER-specific stid: the lesson just carries on
    expect(out.stateTransitionIds.some((x) => x.startsWith('aser'))).toBe(
      false,
    );
    expect(w.aser()).toMatchObject({
      status: 'done',
      result: 'paragraph',
      placementLevel: 9,
    });

    // the lesson after the test: placed at level 9 (normal selection)
    // — drain the story lesson first (second read fails it out)
    while (w.last().snapshot.status !== 'done') {
      await w.say('कुछ भी नहीं');
    }
    out = await w.next();
    expect(w.normalSelections).toEqual([9]);
    // progression never reads ASER rows
    const selectionSql = w.query.mock.calls
      .map((c) => c[0])
      .find((q) => q.includes('recent_distinct_words'))!;
    expect(selectionSql).toContain("snapshot->'context'->>'aser' IS NULL");
    expect(w.last().level).toBe(9);
    expect(w.last().snapshot.context.aser).toBeNull();
  });

  it('first two words wrong → the letter test runs as one letter-loop lesson with the existing stids', async () => {
    const w = makeWorld(ONBOARDING);
    await w.next();
    for (let i = 0; i < 2; i++) {
      if (i > 0) await w.next();
      // drain the wrong word's drill until the lesson ends
      await w.say('क');
      while (w.last().snapshot.status !== 'done') await w.say('क');
    }
    expect(w.aser().stage).toBe('letter');
    expect(w.aser().counts.word).toEqual({ correct: 0, incorrect: 2 });
    let out = await w.next();
    const queue = w.last().snapshot.context.wrongLetters as string[];
    expect(queue).toHaveLength(10);
    expect(out.stateTransitionIds).toEqual([
      `${queue[0]}-word-routeWrongLetter-drillLetters`,
    ]);
    // four letters right: "correct, next letter" ×3, then the normal
    // "…-last" return to the next ASER word
    for (let i = 0; i < 3; i++) {
      out = await w.say(queue[i]);
      expect(out.stateTransitionIds).toEqual([
        `${queue[i + 1]}-letter-routeWrongLetter-correct-more`,
      ]);
    }
    out = await w.say(queue[3]);
    const nextWord = w.last().snapshot.context.word as string;
    expect(out.stateTransitionIds).toEqual([
      `${nextWord}-letter-word-correct-last`,
    ]);
    expect(w.aser().outcomes.letter).toBe('passed');
    expect(w.aser().counts.letter).toEqual({ correct: 4, incorrect: 0 });
    expect(w.aser().item).toEqual({ stage: 'word', value: nextWord });
    // that word's first answer is the next word-test answer
    await w.say(nextWord);
    expect(w.aser().counts.word).toEqual({ correct: 1, incorrect: 2 });
  });

  it('everything wrong at onboarding: word test 0–2 (undecided), letter test 0–7 (failed)', async () => {
    const w = makeWorld(ONBOARDING);
    await w.next();
    for (let i = 0; i < 2; i++) {
      if (i > 0) await w.next();
      await w.say('क');
      while (w.last().snapshot.status !== 'done') await w.say('क');
    }
    await w.next();
    let guard = 0;
    while (w.aser().status !== 'done' && guard++ < 100) await w.say('क');
    expect(w.aser()).toMatchObject({
      status: 'done',
      result: 'beginner',
      placementLevel: 1,
      outcomes: { letter: 'failed' },
    });
    expect(w.aser().counts.letter).toEqual({ correct: 0, incorrect: 7 });
    expect(w.aser().counts.word).toEqual({ correct: 0, incorrect: 2 });
  });

  it('an abandoned item is delivered again (resume)', async () => {
    const w = makeWorld(ONBOARDING);
    await w.next();
    const word = w.last().snapshot.context.word;
    // the student goes quiet; much later a new lesson starts
    w.last().created_at = new Date(Date.now() - 3_600_000);
    await w.next();
    expect(w.last().snapshot.context.word).toBe(word);
    expect(w.aser().used.word).toEqual([word]);
  });

  it('no test once MPL-B has been passed', async () => {
    const w = makeWorld({
      has_lessons: true,
      last_run: null,
      last_milestone: null,
      story_passed: false,
      mpl_b_passed: true,
      active_ms: 50 * 3_600_000,
    });
    await w.next();
    expect(w.last().snapshot.context.aser).toBeNull();
  });

  it('a retest at 5 h: a bank not yet shown, starting at the student’s level (9 → paragraph)', async () => {
    const w = makeWorld({
      has_lessons: true,
      last_run: 2,
      last_milestone: 2,
      story_passed: false,
      mpl_b_passed: false,
      active_ms: 5.2 * 3_600_000,
      bank_history: [
        { run: 1, bank: 'C', shown: true },
        { run: 2, bank: 'A', shown: true },
      ],
      lesson_level: 9,
    });
    await w.next();
    expect(w.aser()).toMatchObject({
      run: 3,
      milestone: 5,
      startStage: 'paragraph',
      stage: 'paragraph',
      placementLevel: null,
    });
    expect(['B', 'D', 'E']).toContain(w.aser().bank);
    expect(w.last().passage_id).toBe(w.aser().item!.value);
  });

  it('not due between milestones', async () => {
    const w = makeWorld({
      has_lessons: true,
      last_run: 2,
      last_milestone: 2,
      story_passed: false,
      mpl_b_passed: false,
      active_ms: 4.9 * 3_600_000,
    });
    await w.next();
    expect(w.last().snapshot.context.aser).toBeNull();
  });

  it('the paragraph skips passages containing a word drilled at the word level', async () => {
    const rnd = jest.spyOn(Math, 'random').mockReturnValue(0.1);
    const w = makeWorld(ONBOARDING);
    await w.next();
    expect(w.last().snapshot.context.word).toBe('जय'); // in P9[0]
    await w.say('क');
    while (w.last().snapshot.status !== 'done') await w.say('क');
    for (let i = 0; i < 4; i++) {
      await w.next();
      await w.say(w.last().snapshot.context.word as string);
    }
    expect(w.aser().outcomes.word).toBe('passed');
    expect(w.aser().wordDrills).toEqual(['जय']);
    await w.next();
    expect(w.last().passage_id).toBe(P9[1].id);
    rnd.mockRestore();
  });
});
