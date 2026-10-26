import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ACTIVITY_EVENT_SQL,
  COUNTED_GAP_SQL,
  IS_TAP_SQL,
} from '../../users/active-time';
import { IST_DATE_SQL } from '../../users/daily-activity.sql';
import { splitLessonWords } from '../literacy-lesson/lesson-words.utils';
import {
  abandonAser,
  ASER_BANKS,
  ASER_PARAGRAPH_PASSAGE_LEVEL,
  ASER_STORY_PASSAGE_LEVEL,
  type AserBankHistoryEntry,
  aserMilestoneForHours,
  aserStartStage,
  type AserItem,
  type AserState,
  chooseBank,
  excludedPassageWords,
  newAserState,
  remainingBankItems,
  withItem,
} from './aser';

// What the next lesson is, decided at every fresh lesson start.
export type AserPlan =
  | {
      kind: 'aser';
      aser: AserState;
      // Machine input: the letter test (aserLetters — one lesson over the
      // remaining bank letters), a word, or a passage (sentence + passageId
      // + its level).
      input: {
        word: string;
        aserLetters?: {
          letters: string[];
          correct: number;
          incorrect: number;
          passWord: string;
          failWord: string;
        };
        sentence?: string[];
        passageId?: string;
        level?: number;
      };
    }
  | {
      kind: 'normal';
      // The onboarding test's placement, for the first lesson after it.
      forcedLevel: number | null;
      // A test that had to end at this start (no passage left to deliver):
      // the caller stores it on the lesson row so the run is recorded.
      finishedAser: AserState | null;
    };

const NORMAL: AserPlan = {
  kind: 'normal',
  forcedLevel: null,
  finishedAser: null,
};

// Candidate passages fetched per ASER passage draw; unseen ones first.
const PASSAGE_CANDIDATES = 500;

interface DueRow {
  has_lessons: boolean;
  last_run: number | null;
  last_milestone: number | null;
  story_passed: boolean;
  mpl_b_passed: boolean;
  active_ms: string | number | null;
  // Each past run's bank and whether any of it was shown (its latest row).
  bank_history: AserBankHistoryEntry[] | null;
  // The latest normal lesson's level (ASER rows have none).
  lesson_level: number | null;
}

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Delivers the ASER test inside the normal lesson loop. Reads only — the
// test state is persisted by LiteracyLessonService inside each lesson row's
// snapshot (context.aser), the source of truth for scheduling and results.
@Injectable()
export class AserService {
  private readonly logger = new Logger(AserService.name);

  constructor(private readonly dataSource: DataSource) {}

  // `prev` is the latest lesson row's context.aser (null / undefined when
  // that row is a normal lesson or there is none).
  async planFreshLesson(
    userId: string,
    prev: AserState | null | undefined,
  ): Promise<AserPlan> {
    if (prev && prev.status === 'in_progress') {
      // Resume: an item never answered (abandoned) is delivered again; an
      // abandoned letter test restarts on the letters not yet answered.
      if (prev.item && !prev.item.answered) {
        return this.deliver(userId, prev, prev.item);
      }
      return this.drawNext(userId, prev);
    }
    if (prev && prev.status === 'done') {
      // The lesson right after a test: the onboarding test places the
      // student; a retest returns them to their pre-test level (ASER rows
      // carry no level, so the ratchet reads the last normal lesson's).
      return {
        kind: 'normal',
        forcedLevel: prev.placementLevel ?? null,
        finishedAser: null,
      };
    }
    const due = await this.dueTest(userId);
    if (!due) return NORMAL;
    this.logger.log(
      `planFreshLesson: starting ASER run ${due.run} (milestone ${due.milestone}h, bank ${due.bank}, at ${due.startStage}) for user ${userId}`,
    );
    return this.drawNext(
      userId,
      newAserState(due.run, due.milestone, due.bank, due.startStage),
    );
  }

  // Is a test due now? Never once the student has passed MPL-B (any nightly
  // snapshot) or the ASER story level. Milestone 0 = the first lesson ever
  // (right after onboarding); then 2 h, 5 h, 10 h, every 5 h of all-time
  // active time (users/active-time.ts rule, per IST day like the nightly
  // usage metric and its backfill) — one test per milestone reached.
  private async dueTest(userId: string): Promise<{
    run: number;
    milestone: number;
    bank: ReturnType<typeof chooseBank>;
    startStage: ReturnType<typeof aserStartStage>;
  } | null> {
    const rows: DueRow[] = await this.dataSource.query(
      `/* aser:due */
       WITH aser AS (
         SELECT created_at,
                (snapshot->'context'->'aser'->>'run')::int AS run,
                (snapshot->'context'->'aser'->>'milestone')::int AS milestone,
                snapshot->'context'->'aser'->>'result' AS result,
                snapshot->'context'->'aser'->>'bank' AS bank,
                jsonb_array_length(snapshot->'context'->'aser'->'used'->'letter')
                  + jsonb_array_length(snapshot->'context'->'aser'->'used'->'word')
                  > 0 AS shown
         FROM literacy_lesson_states
         WHERE user_id = $1
           AND snapshot->'context'->'aser'->>'run' IS NOT NULL
       ),
       run_latest AS (
         SELECT DISTINCT ON (run) run, bank, shown
         FROM aser ORDER BY run, created_at DESC
       ),
       msgs AS (
         SELECT created_at, ${IS_TAP_SQL()} AS is_tap,
                LAG(created_at) OVER (ORDER BY created_at) AS prev_created_at
         FROM media_metadata
         WHERE user_id = $1 AND ${ACTIVITY_EVENT_SQL()}
       ),
       gaps AS (
         SELECT is_tap,
                ${IST_DATE_SQL('created_at')} AS ist_date,
                ${IST_DATE_SQL('prev_created_at')} AS prev_ist_date,
                EXTRACT(EPOCH FROM (created_at - prev_created_at)) * 1000
                  AS gap_ms
         FROM msgs
       )
       SELECT
         EXISTS (SELECT 1 FROM literacy_lesson_states WHERE user_id = $1)
           AS has_lessons,
         (SELECT MAX(run) FROM aser) AS last_run,
         (SELECT MAX(milestone) FROM aser) AS last_milestone,
         EXISTS (SELECT 1 FROM aser WHERE result = 'story') AS story_passed,
         EXISTS (SELECT 1 FROM test_results_student
                 WHERE student_id = $1 AND mpl_b_passed = true)
           AS mpl_b_passed,
         (SELECT json_agg(json_build_object('run', run, 'bank', bank, 'shown', shown))
          FROM run_latest) AS bank_history,
         (SELECT level FROM literacy_lesson_states
          WHERE user_id = $1 AND level IS NOT NULL
          ORDER BY created_at DESC LIMIT 1) AS lesson_level,
         (SELECT COALESCE(ROUND(SUM(gap_ms)), 0) FROM gaps
          WHERE prev_ist_date = ist_date
            AND ${COUNTED_GAP_SQL('gap_ms', 'is_tap')}) AS active_ms`,
      [userId],
    );
    const r = rows[0];
    if (!r || r.story_passed || r.mpl_b_passed) return null;
    const milestone = r.has_lessons
      ? aserMilestoneForHours(Number(r.active_ms ?? 0) / 3_600_000)
      : 0;
    const last = r.last_milestone == null ? -1 : Number(r.last_milestone);
    if (milestone === null || milestone <= last) return null;
    return {
      run: Number(r.last_run ?? 0) + 1,
      milestone,
      bank: chooseBank(r.bank_history ?? []),
      startStage: aserStartStage(
        milestone,
        r.lesson_level == null ? null : Number(r.lesson_level),
      ),
    };
  }

  private async drawNext(userId: string, state: AserState): Promise<AserPlan> {
    if (state.stage === 'letter') {
      const letters = shuffle(remainingBankItems(state));
      if (letters.length === 0) {
        // Unreachable: 4 right / 7 wrong always decides within 10 letters.
        this.logger.warn(
          `drawNext: letter bank ${state.bank} exhausted for user ${userId} — ending ASER run ${state.run}`,
        );
        return this.endEarly(state);
      }
      // The word the letter loop returns to: the next ASER word when the
      // letters pass and words are undecided; otherwise (and on a fail —
      // the test is over then) a bank word just for practice.
      const words = shuffle(remainingBankItems({ ...state, stage: 'word' }));
      const spare =
        words.length > 0 ? words : [...ASER_BANKS[state.bank].words];
      const c = state.counts.letter;
      return {
        kind: 'aser',
        aser: { ...state, item: null },
        input: {
          word: spare[0],
          aserLetters: {
            letters,
            correct: c.correct,
            incorrect: c.incorrect,
            passWord: spare[0],
            failWord: spare[spare.length > 1 ? 1 : 0],
          },
        },
      };
    }
    if (state.stage === 'word') {
      const remaining = remainingBankItems(state);
      if (remaining.length === 0) {
        // Unreachable: 4 right / 7 wrong always decides within 10 words.
        this.logger.warn(
          `drawNext: word bank ${state.bank} exhausted for user ${userId} — ending ASER run ${state.run}`,
        );
        return this.endEarly(state);
      }
      const value = remaining[Math.floor(Math.random() * remaining.length)];
      const item: AserItem = { stage: 'word', value };
      return this.deliver(userId, withItem(state, item), item);
    }
    const passage = await this.selectPassage(userId, state);
    if (!passage) {
      this.logger.warn(
        `drawNext: no level-${state.stage === 'story' ? ASER_STORY_PASSAGE_LEVEL : ASER_PARAGRAPH_PASSAGE_LEVEL} passage for ASER ${state.stage} (user ${userId}) — ending run ${state.run}`,
      );
      return this.endEarly(state);
    }
    const item: AserItem = { stage: state.stage, value: passage.id };
    return {
      kind: 'aser',
      aser: withItem(state, item),
      input: {
        word: '',
        sentence: splitLessonWords(passage.text),
        passageId: passage.id,
        level: passage.level,
      },
    };
  }

  // Builds the plan for an item already chosen (a resumed one, or a letter
  // / word just drawn). Passages are re-read for a resumed passage item.
  private async deliver(
    userId: string,
    state: AserState,
    item: AserItem,
  ): Promise<AserPlan> {
    if (item.stage === 'letter') {
      // Letters are only ever recorded once answered (applyAserTurn).
      return this.drawNext(userId, { ...state, item: null });
    }
    if (item.stage === 'word') {
      return { kind: 'aser', aser: state, input: { word: item.value } };
    }
    const rows: Array<{ id: string; text: string; level: number }> =
      await this.dataSource.query(
        `SELECT id, text, (media_details->>'level')::int AS level
         FROM media_metadata WHERE id = $1 AND rolled_back = false`,
        [item.value],
      );
    if (rows.length === 0) {
      // The passage was culled since: draw a fresh one for the same stage.
      this.logger.warn(
        `deliver: ASER passage ${item.value} gone for user ${userId} — drawing another`,
      );
      return this.drawNext(userId, { ...state, item: null });
    }
    return {
      kind: 'aser',
      aser: state,
      input: {
        word: '',
        sentence: splitLessonWords(rows[0].text),
        passageId: rows[0].id,
        level: rows[0].level,
      },
    };
  }

  private endEarly(state: AserState): AserPlan {
    const finished = abandonAser(state);
    return {
      kind: 'normal',
      forcedLevel: finished.placementLevel,
      finishedAser: finished,
    };
  }

  // A ready level-9 (paragraph) / level-10 (story) passage containing none
  // of the excluded words (aser.ts excludedPassageWords), not used earlier
  // in this run; passages the student has never been assigned first. If
  // every candidate contains an excluded word the exclusion is dropped
  // rather than ending the test (logged).
  private async selectPassage(
    userId: string,
    state: AserState,
  ): Promise<{ id: string; text: string; level: number } | null> {
    const level =
      state.stage === 'story'
        ? ASER_STORY_PASSAGE_LEVEL
        : ASER_PARAGRAPH_PASSAGE_LEVEL;
    const usedInRun = [...state.used.paragraph, ...state.used.story];
    const rows: Array<{ id: string; text: string; level: number }> =
      await this.dataSource.query(
        `SELECT m.id, m.text, (m.media_details->>'level')::int AS level
         FROM media_metadata m
         WHERE m.media_type = 'text' AND m.status = 'ready'
           AND m.rolled_back = false
           AND m.media_details->>'role' = 'passage'
           AND (m.media_details->>'level')::int = $2
           AND m.text IS NOT NULL
           AND NOT (m.id = ANY($3::uuid[]))
         ORDER BY EXISTS (
                    SELECT 1 FROM literacy_lesson_states s
                    WHERE s.user_id = $1 AND s.passage_id = m.id
                  ),
                  random()
         LIMIT ${PASSAGE_CANDIDATES}`,
        [userId, level, usedInRun],
      );
    const excluded = excludedPassageWords(state);
    const clean = rows.find(
      (p) => !splitLessonWords(p.text).some((w) => excluded.has(w)),
    );
    if (clean) return clean;
    if (rows.length > 0) {
      this.logger.warn(
        `selectPassage: every level-${level} candidate contains an excluded word (${excluded.size} excluded) for user ${userId} — using one anyway`,
      );
      return rows[0];
    }
    return null;
  }
}
