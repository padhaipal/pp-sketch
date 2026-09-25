import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SpanStatusCode } from '@opentelemetry/api';
import { Repository, DataSource } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';
import { createActor } from 'xstate';
import { LiteracyLessonStateEntity } from './literacy-lesson-state.entity';
import { ScoreService } from '../score/score.service';
import { tracer } from '../../otel/otel';
import {
  machine,
  STALE_LESSON_RESTART_STATE_TRANSITION_ID,
} from './literacy-lesson.machine';
import {
  LessonSnapshot,
  LiteracyLessonState,
  ProcessAnswerOptions,
  ProcessAnswerResult,
  validateProcessAnswerOptions,
} from './literacy-lesson.dto';
import {
  SENTENCE_RECENT_ROWS_WINDOW,
  TurnRow,
  computeSentenceBandSignal,
} from './sentence-band-signal.utils';

const RECENT_WORDS_TO_EXCLUDE = 10;
const SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH = 8;
const SNAPSHOT_THRESHOLD_KEEP_WORD_LENGTH_SAME = 15;
const MIN_UNIQUE_WORDS_FOR_PROGRESS = 3;
const MIN_WORD_LENGTH_FLOOR = 2;
const NEW_USER_THRESHOLD = 3;
// Fast-find accelerator: a student cruising through recent words jumps the
// cap by +3 instead of +1 so they reach their real level in fewer lessons.
// A first-try-correct word costs exactly 2 rows (its selection row + its
// 'done' row — see MIN complete-word:row ratio of 2), so "3 distinct
// completed words in the last 6 rows" is only reachable when the last three
// lessons were all completed first try. The 2-row / 4-row conditions catch a
// perfect first (or first-two) start, when the new-user gate would otherwise
// pin the student at level 2.
const LEVEL_BOOST_WINDOW = 6;
const LEVEL_BOOST_INCREMENT = 3;
const FIRST_WORD_ROW_COUNT = 2;
const SECOND_WORD_ROW_COUNT = 4;
// Above this lesson level the student gets a reading passage (LLM-generated,
// selected from media_metadata by media_details.level) instead of single
// words. Passage levels are computed from word count at seeding time:
// <10 words → 8, <40 → 9, <70 → 10, <110 → 11, else 12.
import { PASSAGE_COMPREHENSION_INITIAL_SUFFIX } from '../../media-meta-data/llm-generate.dto';

const SENTENCE_LEVEL_THRESHOLD = 7;
// Level 11+ (2026-09): no read-aloud — the lesson opens on the comprehension
// flow with the passage text inside it. Keyed on the STUDENT's selected
// level, so a nearest-level fallback passage is still read in the flow.
const PASSAGE_FLOW_LEVEL_THRESHOLD = 11;
const MAX_LESSON_LEVEL = 12;
// Ops lever: MAX_LESSON_LEVEL_CAP (env) lowers the selection ceiling — e.g. 7
// holds every student in the word band while the passage bank is re-seeded
// (the 2026-08 TEMP cap of #65/#72, now toggled via Railway instead of a
// code revert). Unset or outside [MIN_WORD_LENGTH_FLOOR, MAX_LESSON_LEVEL]
// means no extra cap. Read per selection so specs can toggle it; in prod a
// Railway variable change redeploys the service.
function effectiveMaxLessonLevel(): number {
  const cap = parseInt(process.env.MAX_LESSON_LEVEL_CAP ?? '', 10);
  return cap >= MIN_WORD_LENGTH_FLOOR && cap <= MAX_LESSON_LEVEL
    ? cap
    : MAX_LESSON_LEVEL;
}
// Sentence-band (level ≥ 8) progression: the SQL only ships the raw recent
// turns + a lifetime done count; grouping into lessons and the ±1/hold
// decision live in the pure computeSentenceBandSignal
// (sentence-band-signal.utils.ts), which also owns
// SENTENCE_RECENT_ROWS_WINDOW (the row-scan window doubles as its
// entire-history-visible threshold).
// Passages excluded from re-selection: effectively EVERY passage the student
// has ever been assigned (was 10 — a student saw the same passage again after
// ten others). A student never sees a passage twice while any unseen passage
// exists at any lesson level; only when the whole bank is exhausted does
// selectPassage fall back to least-recently-seen reuse (see its ladder).
// The list is per student (hundreds to low thousands of ids), so shipping it
// as one array is cheap.
const RECENT_PASSAGES_TO_EXCLUDE = 10_000_000;
// The three machine transitions that land in the `sentence` state — the
// student is holding the reading passage and expected to record a full read
// (see literacy-lesson.machine.ts). Extends the stale-restart window only.
const PASSAGE_READ_STIDS = new Set([
  'sentence-start-sentence-initial',
  'sentence-sentence-wrong-retry',
  'sentence-word-sentence-correct-retrySentence',
]);
// The four machine transitions that record a CORRECT full passage read
// (level 8 → complete, level 9+ → comprehension; first try or retry). The
// stid alone is not enough: the comprehension state's voice-note nudge
// re-emits `…-sentence-comprehension-correct-retry` with answerCorrect null,
// so callers must also check answerCorrect === true.
const CORRECT_PASSAGE_READ_STID_RE =
  /-sentence-(?:complete|comprehension)-correct-(?:first|retry)$/;
// Joins the per-engine STT transcripts for the word-lesson evaluators. The
// tilde is stripped by their clean() step so it can never match anything,
// but it stops the tail of one engine's transcript and the head of the
// other's from jointly forming a correct answer. Deliberately NOT '|', which
// reads like the Devanagari danda (।) and could plausibly appear in a
// transcript; a tilde never occurs naturally in Hindi STT output. Sentence
// evaluation ignores the combined string entirely and works on the
// per-engine transcripts.
const TRANSCRIPT_JOIN = ' ~ ';

interface NextString {
  word: string;
  sentence: string[] | null;
  // Difficulty cap this lesson was selected at, persisted so the next
  // selection ratchets from the stored value instead of re-deriving from the
  // last word's length (which could never climb).
  level: number;
  // media_metadata id of the selected reading passage; null for word lessons.
  passageId: string | null;
  // The passage's own word-count level (media_details.level). Can differ
  // from `level` when selectPassage fell back to the nearest level; the
  // lesson machine keys its level-8 skip-comprehension guard on THIS value
  // because the generation gates are keyed on it too. Null for word lessons.
  passageLevel: number | null;
}

// Splits a persisted `word` column value into its component words. Sentences
// are stored space-joined today, but tolerate full paragraph punctuation
// (danda, double danda, commas, Latin stops, quotes, dashes) so a future
// punctuated paragraph still round-trips into clean words for recency
// exclusion and level derivation.
function splitLessonWords(stored: string): string[] {
  return stored
    .split(/[\s।॥,.!?;:'"“”‘’()[\]{}\-–—~]+/u)
    .filter((w) => w.length > 0);
}

// Lesson level of a persisted `word` column value: grapheme count for a
// single word, 7 + log2(word count) for a stored sentence (the inverse of
// the 2^(level − 7) sizing rule).
function lessonLevel(stored: string): number {
  const parts = splitLessonWords(stored);
  if (parts.length > 1) {
    return SENTENCE_LEVEL_THRESHOLD + Math.ceil(Math.log2(parts.length));
  }
  return Array.from(parts[0] ?? stored).length;
}

@Injectable()
export class LiteracyLessonService {
  private readonly logger = new Logger(LiteracyLessonService.name);
  private readonly wordList: string[];

  constructor(
    @InjectRepository(LiteracyLessonStateEntity)
    private readonly lessonStateRepo: Repository<LiteracyLessonStateEntity>,
    private readonly dataSource: DataSource,
    private readonly scoreService: ScoreService,
  ) {
    const wordListPath = path.join(__dirname, 'word-list.json');
    this.wordList = JSON.parse(
      fs.readFileSync(wordListPath, 'utf-8'),
    ) as string[];
  }

  async processAnswer(
    options: ProcessAnswerOptions,
  ): Promise<ProcessAnswerResult> {
    return tracer.startActiveSpan('literacy.processAnswer', async (span) => {
      try {
        // 1. Validate
        const validated = validateProcessAnswerOptions(options);
        span.setAttribute('pp.user.id', validated.user.id);
        span.setAttribute(
          'pp.lesson.user_message_id',
          validated.user_message_id,
        );

        // 2. Build combined transcript
        let combinedTranscript: string | undefined;
        let transcriptTexts: string[] | undefined;
        if (validated.transcripts && validated.transcripts.length > 0) {
          transcriptTexts = validated.transcripts.map((t) => t.text ?? '');
          combinedTranscript = transcriptTexts.join(TRANSCRIPT_JOIN);
        }

        // 3. Find current state
        const currentState = await this.findCurrentState(validated.user.id);

        // 3b. Comprehension flow submission — separate path: staleness rules
        // don't apply (a flow tap may arrive minutes later) and the answer id
        // comes from the user's device, so it is validated against the
        // current lesson's passage before anything is recorded.
        if (validated.comprehension_answer_id) {
          const result = await this.handleComprehensionAnswer(
            validated.user.id,
            validated.user_message_id,
            validated.comprehension_answer_id,
            currentState,
          );
          span.setAttribute('pp.lesson.path', 'comprehension-answer');
          span.setAttribute('pp.lesson.ignored', result.ignored === true);
          if (result.stateTransitionIds.length > 0) {
            span.setAttribute(
              'pp.lesson.state_transition_id',
              result.stateTransitionIds[0],
            );
          }
          return result;
        }

        // 4. Determine fresh or continue
        let startFresh = false;
        let isStaleRestart = false;
        let lessonPath:
          | 'fresh'
          | 'stale-restart'
          | 'continue'
          | 'complete-restart' = 'continue';
        if (!currentState) {
          startFresh = true;
          lessonPath = 'fresh';
        } else {
          const age = Date.now() - new Date(currentState.created_at).getTime();
          // Staleness window: reading (and rehearsing) a full passage takes
          // far longer than a single-word answer, so the three transitions
          // that leave the student holding the passage awaiting a read get
          // 4 min 58 s; everything else keeps 2 min. The 15-min hard
          // restart above is unchanged.
          const lastStid =
            currentState.snapshot?.context?.stateTransitionId ?? '';
          // Reading the passage INSIDE the flow (level 11+) takes as long as
          // reading it aloud, so that wait gets the long window too.
          const awaitingPassageRead =
            PASSAGE_READ_STIDS.has(lastStid) ||
            lastStid.endsWith(`-${PASSAGE_COMPREHENSION_INITIAL_SUFFIX}`);
          const staleMs = awaitingPassageRead ? 298_000 : 120_000;
          if (age > 900_000) {
            startFresh = true;
            lessonPath = 'fresh';
          } else if (age > staleMs) {
            startFresh = true;
            isStaleRestart = true;
            lessonPath = 'stale-restart';
          } else if (currentState.snapshot?.status === 'done') {
            startFresh = true;
            lessonPath = 'complete-restart';
          }
        }
        span.setAttribute('pp.lesson.path', lessonPath);

        let snapshot: LessonSnapshot;
        // Difficulty cap written onto this row: freshly computed for a new
        // lesson, carried forward from the current lesson's row on continue.
        // Null only for a continue against a pre-migration row that never had
        // a level — self-heals on the next fresh selection.
        let selectedLevel: number | null;

        if (startFresh) {
          // 5. Start a new lesson
          const lesson = await this.selectNextString(validated.user.id);
          selectedLevel = lesson.level;
          const actor = createActor(machine, {
            input: {
              word: lesson.word,
              sentence: lesson.sentence ?? undefined,
              passageId: lesson.passageId ?? undefined,
              level: lesson.passageLevel ?? undefined,
              readInFlow:
                lesson.passageId != null &&
                lesson.level >= PASSAGE_FLOW_LEVEL_THRESHOLD,
              userMessageId: validated.user_message_id,
            },
          });
          actor.start();

          snapshot = actor.getSnapshot();
          actor.stop();
        } else {
          selectedLevel = currentState!.level ?? null;
          // 6. Rehydrate and run
          if (combinedTranscript === undefined) {
            throw new BadRequestException(
              'Rehydrating an existing lesson requires a student answer',
            );
          }

          const restoredSnapshot = {
            ...currentState!.snapshot,
            context: {
              ...currentState!.snapshot.context,
              userMessageId: validated.user_message_id,
            },
          } as unknown as LessonSnapshot;

          const actor = createActor(machine, {
            snapshot: restoredSnapshot,
            input: { word: '', userMessageId: '' },
          });
          actor.start();

          actor.send({
            type: 'ANSWER',
            studentAnswer: combinedTranscript,
            studentTranscripts: transcriptTexts,
          });

          snapshot = actor.getSnapshot();
          actor.stop();
        }

        // 7. Read pending scores
        const pendingCorrect: string[] = snapshot.context.pendingCorrect ?? [];
        const pendingIncorrect: string[] =
          snapshot.context.pendingIncorrect ?? [];

        // 8. Persist snapshot
        const answer: string | null = snapshot.context.answer ?? null;
        const answerCorrect: boolean | null =
          snapshot.context.answerCorrect ?? null;
        // For a sentence lesson the word column always holds the full
        // space-joined sentence (even mid-drill, when context.word is the
        // drilled word) — recency exclusion and lesson-level derivation in
        // selectNextString read it back.
        const persistedWord: string = snapshot.context.sentence?.length
          ? snapshot.context.sentence.join(' ')
          : snapshot.context.word;
        const passageId: string | null = snapshot.context.passageId ?? null;
        const rows: unknown[] = await this.dataSource.query(
          `INSERT INTO literacy_lesson_states (user_id, user_message_id, word, answer, answer_correct, snapshot, level, passage_id, created_at)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, now()
           FROM media_metadata m
           WHERE m.id = $2 AND m.rolled_back = false
           RETURNING *`,
          [
            validated.user.id,
            validated.user_message_id,
            persistedWord,
            answer,
            answerCorrect,
            JSON.stringify(snapshot),
            selectedLevel,
            passageId,
          ],
        );

        if (rows.length === 0) {
          this.logger.warn(
            `processAnswer: INSERT returned 0 rows — media ${validated.user_message_id} rolled_back=true or does not exist`,
          );
          throw new Error(
            'Media was rolled back — cannot persist lesson state',
          );
        }
        // 9. Record scores
        if (pendingCorrect.length > 0 || pendingIncorrect.length > 0) {
          try {
            await this.scoreService.gradeAndRecord({
              user: validated.user,
              correct: pendingCorrect.length > 0 ? pendingCorrect : undefined,
              incorrect:
                pendingIncorrect.length > 0 ? pendingIncorrect : undefined,
              userMessageId: validated.user_message_id,
            });
          } catch (err) {
            this.logger.warn(
              `processAnswer: gradeAndRecord failed: ${(err as Error).message}`,
            );
          }
        }

        // 10. Return
        const snapshotContext = snapshot.context as {
          stateTransitionId: string;
          word?: unknown;
        };
        const stateTransitionIds = isStaleRestart
          ? [
              STALE_LESSON_RESTART_STATE_TRANSITION_ID,
              snapshotContext.stateTransitionId,
            ]
          : [snapshotContext.stateTransitionId];

        const isComplete = snapshot.status === 'done';
        span.setAttribute(
          'pp.lesson.state_transition_id',
          snapshotContext.stateTransitionId,
        );
        span.setAttribute('pp.lesson.is_complete', isComplete);
        if (typeof snapshotContext.word === 'string') {
          span.setAttribute('pp.lesson.word', snapshotContext.word);
        }

        // The next prompt is the sentence itself (fresh sentence lesson or a
        // retry after a word drill). Its text is generated at runtime, so the
        // caller must send it as a text message — see ProcessAnswerResult.
        // Display uses the passage row's RAW text (danda, commas, title
        // separator intact) — the tokenized join strips punctuation and is
        // for alignment/scoring only; it remains the fallback for
        // pre-passage snapshots or a missing/rolled-back passage row.
        let sentenceText: string | undefined;
        if (
          snapshot.value === 'sentence' &&
          snapshot.context.sentence?.length
        ) {
          sentenceText = snapshot.context.sentence.join(' ');
          if (snapshot.context.passageId) {
            const passageRows: Array<{ text: string | null }> =
              await this.dataSource.query(
                `SELECT text FROM media_metadata
                 WHERE id = $1 AND rolled_back = false`,
                [snapshot.context.passageId],
              );
            if (passageRows[0]?.text) {
              sentenceText = passageRows[0].text;
            }
          }
        }
        if (sentenceText !== undefined) {
          span.setAttribute('pp.lesson.sentence', sentenceText);
        }

        // Level 11+ flow-mode lesson awaiting its tap (initial send or the
        // voice-note nudge): the passage rides INSIDE the flow, so the caller
        // gets its raw text for flow_action_payload.data.passage_text and
        // never a plain text message (sentenceText stays unset here).
        let flowPassageText: string | undefined;
        if (
          snapshot.value === 'comprehension' &&
          snapshot.context.readInFlow === true &&
          snapshot.context.passageId
        ) {
          const passageRows: Array<{ text: string | null }> =
            await this.dataSource.query(
              `SELECT text FROM media_metadata
               WHERE id = $1 AND rolled_back = false`,
              [snapshot.context.passageId],
            );
          flowPassageText =
            passageRows[0]?.text ?? snapshot.context.sentence?.join(' ');
        }

        // This turn was a CORRECT passage read (level 8 → done, 9+ → awaiting
        // comprehension — lesson completion is irrelevant): hand the caller
        // the token count so it can derive a reading-speed stid. Token array,
        // never the raw passage text — the count must match what alignment
        // scored, and punctuation is not a word.
        const sentenceTokens = snapshot.context.sentence;
        const completedReading =
          snapshot.context.answerCorrect === true &&
          CORRECT_PASSAGE_READ_STID_RE.test(
            snapshotContext.stateTransitionId,
          ) &&
          sentenceTokens != null &&
          sentenceTokens.length > 0 &&
          selectedLevel != null &&
          selectedLevel > SENTENCE_LEVEL_THRESHOLD
            ? { wordCount: sentenceTokens.length, level: selectedLevel }
            : undefined;

        return {
          stateTransitionIds,
          isComplete,
          sentenceText,
          completedReading,
          flowPassageText,
        };
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  // Handles a comprehension flow submission. The answerId arrived from the
  // student's device via nfm_reply, so it is UNTRUSTED: it must resolve to a
  // live answer-option row whose question belongs to the current lesson's
  // passage, and the machine must actually be awaiting a comprehension
  // answer. Anything else is ignored (nothing persisted, nothing sent).
  private async handleComprehensionAnswer(
    userId: string,
    userMessageId: string,
    answerId: string,
    currentState: LiteracyLessonState | null,
  ): Promise<ProcessAnswerResult> {
    const ignored: ProcessAnswerResult = {
      stateTransitionIds: [],
      isComplete: false,
      ignored: true,
    };
    if (
      !currentState ||
      currentState.snapshot?.status === 'done' ||
      currentState.snapshot?.value !== 'comprehension' ||
      !currentState.passage_id
    ) {
      this.logger.warn(
        `handleComprehensionAnswer: no comprehension in flight for user ${userId} (answer ${answerId}) — ignoring`,
      );
      return ignored;
    }

    const options: Array<{ id: string; media_details: { correct?: unknown } }> =
      await this.dataSource.query(
        `SELECT o.id, o.media_details
         FROM media_metadata o
         JOIN media_metadata q ON q.id = o.input_media_id
         WHERE o.id = $1 AND o.rolled_back = false
           AND q.rolled_back = false AND q.input_media_id = $2`,
        [answerId, currentState.passage_id],
      );
    if (options.length === 0) {
      this.logger.warn(
        `handleComprehensionAnswer: answer ${answerId} does not belong to passage ${currentState.passage_id} for user ${userId} — ignoring`,
      );
      return ignored;
    }
    const answerCorrect = options[0].media_details?.correct === true;

    const restoredSnapshot = {
      ...currentState.snapshot,
      context: {
        ...currentState.snapshot.context,
        userMessageId,
      },
    } as unknown as LessonSnapshot;
    const actor = createActor(machine, {
      snapshot: restoredSnapshot,
      input: { word: '', userMessageId: '' },
    });
    actor.start();
    actor.send({ type: 'COMPREHENSION_ANSWER', answerId, answerCorrect });
    const snapshot = actor.getSnapshot();
    actor.stop();

    const persistedWord: string | null = snapshot.context.sentence?.length
      ? snapshot.context.sentence.join(' ')
      : (snapshot.context.word ?? null);
    const rows: unknown[] = await this.dataSource.query(
      `INSERT INTO literacy_lesson_states (user_id, user_message_id, word, answer, answer_correct, snapshot, level, passage_id, created_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, now()
       FROM media_metadata m
       WHERE m.id = $2 AND m.rolled_back = false
       RETURNING *`,
      [
        userId,
        userMessageId,
        persistedWord,
        answerId,
        answerCorrect,
        JSON.stringify(snapshot),
        currentState.level,
        currentState.passage_id,
      ],
    );
    if (rows.length === 0) {
      this.logger.warn(
        `handleComprehensionAnswer: INSERT returned 0 rows — media ${userMessageId} rolled_back=true or does not exist`,
      );
      throw new Error('Media was rolled back — cannot persist lesson state');
    }

    this.logger.log(
      `handleComprehensionAnswer: user ${userId} answered ${answerId} correct=${String(answerCorrect)}`,
    );
    return {
      stateTransitionIds: [snapshot.context.stateTransitionId],
      isComplete: snapshot.status === 'done',
    };
  }

  // Random ready reading passage for the level that the student has NEVER
  // been assigned (`seenPassageIds` = every passage in their history, newest
  // first); widens to the nearest level (8-12) before ever repeating. Only
  // when the whole bank is exhausted — no unseen passage at any lesson level
  // — does it reuse, least-recently-seen first (`reused: true`, so the
  // caller can log/alert: time to seed more). The explicit
  // <= MAX_LESSON_LEVEL bound keeps level-13 (250+ word) passages out of
  // lessons even if a future caller skips the maxLength clamp.
  private async selectPassage(
    level: number,
    seenPassageIds: string[],
  ): Promise<{
    id: string;
    text: string;
    level: number;
    reused: boolean;
  } | null> {
    interface PassageRow {
      id: string;
      text: string;
      level: number;
    }
    const seen = seenPassageIds.length > 0 ? seenPassageIds : [];
    const select = `SELECT id, text, (media_details->>'level')::int AS level
       FROM media_metadata
       WHERE media_type = 'text' AND status = 'ready' AND rolled_back = false
         AND media_details->>'role' = 'passage'
         AND (media_details->>'level')::int <= ${MAX_LESSON_LEVEL}`;
    const exactLevel = `AND (media_details->>'level')::int = $1`;
    const bandLevels = `AND (media_details->>'level')::int BETWEEN ${SENTENCE_LEVEL_THRESHOLD + 1} AND ${MAX_LESSON_LEVEL}`;
    const nearestFirst = `ABS((media_details->>'level')::int - $1),`;
    // 1. Exact level, unseen.
    let rows: PassageRow[] = await this.dataSource.query(
      `${select} AND NOT (id = ANY($2::uuid[])) ${exactLevel}
       ORDER BY random() LIMIT 1`,
      [level, seen],
    );
    // 2. Nearest level in the sentence band, unseen.
    if (rows.length === 0) {
      rows = await this.dataSource.query(
        `${select} AND NOT (id = ANY($2::uuid[])) ${bandLevels}
         ORDER BY ${nearestFirst} random() LIMIT 1`,
        [level, seen],
      );
    }
    if (rows.length > 0) return { ...rows[0], reused: false };
    if (seen.length === 0) return null; // empty bank, nothing to reuse
    // 3. Bank exhausted → exact level, least-recently-seen first ($2 is
    //    newest-first, so the highest array position is the oldest).
    rows = await this.dataSource.query(
      `${select} AND id = ANY($2::uuid[]) ${exactLevel}
       ORDER BY array_position($2::uuid[], id) DESC, random() LIMIT 1`,
      [level, seen],
    );
    // 4. Nearest level, least-recently-seen first.
    if (rows.length === 0) {
      rows = await this.dataSource.query(
        `${select} AND id = ANY($2::uuid[]) ${bandLevels}
         ORDER BY ${nearestFirst} array_position($2::uuid[], id) DESC, random() LIMIT 1`,
        [level, seen],
      );
    }
    return rows[0] ? { ...rows[0], reused: true } : null;
  }

  async findCurrentState(userId: string): Promise<LiteracyLessonState | null> {
    const entity = await this.lessonStateRepo.findOne({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
    // jsonb column is `Record<string, unknown>` at the entity level; we trust
    // it conforms to LessonSnapshot because we control writes.
    return (entity ?? null) as LiteracyLessonState | null;
  }

  async cleanupPartialState(userMessageId: string): Promise<void> {
    const { scoresDeleted, statesDeleted } = await this.dataSource.transaction(
      async (manager) => {
        const scoreRows: unknown[] = await manager.query(
          `DELETE FROM scores WHERE user_message_id = $1 RETURNING id`,
          [userMessageId],
        );
        const stateRows: unknown[] = await manager.query(
          `DELETE FROM literacy_lesson_states WHERE user_message_id = $1 RETURNING id`,
          [userMessageId],
        );
        return {
          scoresDeleted: scoreRows.length,
          statesDeleted: stateRows.length,
        };
      },
    );
    this.logger.log(
      `cleanupPartialState: user_message_id=${userMessageId} scores_deleted=${scoresDeleted} lesson_states_deleted=${statesDeleted}`,
    );
  }

  private async selectNextString(userId: string): Promise<NextString> {
    return tracer.startActiveSpan('literacy.selectNextString', async (span) => {
      span.setAttribute('pp.user.id', userId);
      try {
        // Single DB round-trip
        interface SelectNextWordRow {
          letter_scores: { grapheme: string; score: number }[];
          recent_words: string[];
          unique_in_add_window: number;
          unique_in_keep_window: number;
          unique_in_boost_window: number;
          recent_row_count: number;
          distinct_word_count: number;
          // Cap of the most recent row that HAS a stored level. Null when
          // every row is null (post-migration cold state) — the caller then
          // derives the base from the most recent word's length.
          prev_level: number | null;
          // Sentence-band (level ≥ 8) inputs: raw window rows (newest
          // first) + lifetime completion count. Grouping/decision happen in
          // computeSentenceBandSignal.
          recent_turns: TurnRow[];
          lifetime_done_count: number;
          recent_passage_ids: string[];
        }
        const rows: SelectNextWordRow[] = await this.dataSource.query(
          `WITH recent_distinct_words AS (
            SELECT word, MAX(created_at) AS latest_at
            FROM literacy_lesson_states
            WHERE user_id = $1
            GROUP BY word
            ORDER BY latest_at DESC
            LIMIT $2
          ),
          recent_rows AS (
            -- is_done: xstate writes status 'done' only when the machine
            -- reaches its 'complete' final state; timed-out/abandoned words
            -- never get a done row, so they must not count toward progression.
            SELECT word,
                   answer_correct,
                   ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn,
                   (snapshot->>'status' = 'done') AS is_done,
                   snapshot->'context'->>'stateTransitionId' AS stid
            FROM literacy_lesson_states
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $3
          ),
          latest_scores AS (
            SELECT DISTINCT ON (s.letter_id) l.grapheme, s.score
            FROM scores s
            JOIN letters l ON l.id = s.letter_id
            WHERE s.user_id = $1
            ORDER BY s.letter_id, s.created_at DESC
          ),
          distinct_word_count AS (
            SELECT COUNT(DISTINCT word)::int AS count
            FROM literacy_lesson_states
            WHERE user_id = $1
          ),
          recent_passages AS (
            SELECT passage_id, MAX(created_at) AS latest_at
            FROM literacy_lesson_states
            WHERE user_id = $1 AND passage_id IS NOT NULL
            GROUP BY passage_id
            ORDER BY latest_at DESC
            LIMIT $7
          )
          SELECT
            COALESCE(
              (SELECT json_agg(json_build_object('grapheme', grapheme, 'score', score))
               FROM latest_scores),
              '[]'::json
            ) AS letter_scores,
            COALESCE(
              (SELECT json_agg(word ORDER BY latest_at DESC)
               FROM recent_distinct_words),
              '[]'::json
            ) AS recent_words,
            COALESCE(
              (SELECT COUNT(DISTINCT word)::int FROM recent_rows WHERE rn <= $4 AND is_done),
              0
            ) AS unique_in_add_window,
            COALESCE(
              (SELECT COUNT(DISTINCT word)::int FROM recent_rows WHERE rn <= $6 AND is_done),
              0
            ) AS unique_in_keep_window,
            COALESCE(
              (SELECT COUNT(DISTINCT word)::int FROM recent_rows WHERE rn <= $5 AND is_done),
              0
            ) AS unique_in_boost_window,
            COALESCE((SELECT COUNT(*)::int FROM recent_rows), 0) AS recent_row_count,
            COALESCE((SELECT count FROM distinct_word_count), 0) AS distinct_word_count,
            (SELECT s.level FROM literacy_lesson_states s
              WHERE s.user_id = $1 AND s.level IS NOT NULL
              ORDER BY s.created_at DESC
              LIMIT 1) AS prev_level,
            COALESCE(
              (SELECT json_agg(json_build_object('rn', rn, 'is_done', is_done, 'stid', stid, 'answer_correct', answer_correct) ORDER BY rn ASC)
               FROM recent_rows),
              '[]'::json
            ) AS recent_turns,
            (SELECT COUNT(*)::int FROM literacy_lesson_states
              WHERE user_id = $1 AND snapshot->>'status' = 'done'
            ) AS lifetime_done_count,
            COALESCE(
              (SELECT json_agg(passage_id ORDER BY latest_at DESC)
               FROM recent_passages),
              '[]'::json
            ) AS recent_passage_ids`,
          [
            userId,
            RECENT_WORDS_TO_EXCLUDE,
            SENTENCE_RECENT_ROWS_WINDOW,
            SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH,
            LEVEL_BOOST_WINDOW,
            SNAPSHOT_THRESHOLD_KEEP_WORD_LENGTH_SAME,
            RECENT_PASSAGES_TO_EXCLUDE,
          ],
        );

        const data = rows[0];
        const letterScores = data.letter_scores;
        const recentWords = data.recent_words;
        const uniqueInAddWindow = Number(data.unique_in_add_window);
        const uniqueInKeepWindow = Number(data.unique_in_keep_window);
        const uniqueInBoostWindow = Number(data.unique_in_boost_window);
        const recentRowCount = Number(data.recent_row_count);
        const distinctWordCount = Number(data.distinct_word_count);
        // Ratchet base: the last stored cap, or (cold state) the most recent
        // word's own level. recentWords[0] is the most recent row's word
        // because recent_distinct_words orders by MAX(created_at) DESC.
        const prevLevel =
          data.prev_level === null || data.prev_level === undefined
            ? null
            : Number(data.prev_level);

        // Build score map
        const scoreMap = new Map<string, number>();
        for (const ls of letterScores) {
          scoreMap.set(ls.grapheme, ls.score);
        }

        // Exclude recent words. A stored sentence lesson contributes each of
        // its component words to the exclusion set (punctuation-tolerant so a
        // future punctuated paragraph still excludes its clean words).
        const recentSet = new Set(recentWords.flatMap(splitLessonWords));
        let candidates = this.wordList.filter((w) => !recentSet.has(w));

        // Determine max lesson level. The base is the stored cap (ratchet),
        // falling back to the most recent word's own level only when no row
        // has a stored level yet (post-migration cold state). recentWords is
        // empty only at a user's very first selection, where the accelerator
        // can't fire and the new-user gate forces the floor — so `base` is
        // never read against an empty history.
        const base = prevLevel ?? lessonLevel(recentWords[0] ?? '');

        let maxLength: number;
        if (base > SENTENCE_LEVEL_THRESHOLD) {
          // Sentence band (level ≥ 8): grouping + decision live in the pure
          // signal function (see sentence-band-signal.utils.ts for the
          // lesson-validity and rule-ordering rationale).
          const signal = computeSentenceBandSignal(
            data.recent_turns,
            Number(data.lifetime_done_count),
          );
          if (signal.decision === 'increment') {
            maxLength = base + 1;
          } else if (signal.decision === 'decrement') {
            maxLength = base - 1;
          } else {
            maxLength = base;
          }
          span.setAttribute(
            'pp.lesson.sentence.both_first_try_pass',
            signal.bothFirstTryPass,
          );
          span.setAttribute(
            'pp.lesson.sentence.both_entered_image',
            signal.bothEnteredImage,
          );
          span.setAttribute(
            'pp.lesson.sentence.both_failed_out',
            signal.bothFailedOut,
          );
          span.setAttribute(
            'pp.lesson.sentence.done_in_window',
            signal.doneInWindow,
          );
          span.setAttribute(
            'pp.lesson.sentence.low_completion_decrement',
            signal.lowCompletionDecrement,
          );
        } else {
          // Word section (level ≤ 7): fast-find accelerator (+3), checked
          // BEFORE the new-user gate so a strong start escapes the level-2
          // floor: three distinct completed words in the last 6 rows, OR a
          // perfect first word (1 done, 2 rows ever), OR a perfect first two
          // words (2 done, 4 rows ever).
          const accelerate =
            uniqueInBoostWindow >= MIN_UNIQUE_WORDS_FOR_PROGRESS ||
            (uniqueInKeepWindow >= 1 &&
              recentRowCount === FIRST_WORD_ROW_COUNT) ||
            (uniqueInKeepWindow >= 2 &&
              recentRowCount === SECOND_WORD_ROW_COUNT);

          if (accelerate) {
            maxLength = base + LEVEL_BOOST_INCREMENT;
          } else if (
            distinctWordCount < NEW_USER_THRESHOLD ||
            recentRowCount < SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH
          ) {
            maxLength = MIN_WORD_LENGTH_FLOOR;
          } else if (recentWords.length === 0) {
            this.logger.warn(
              `selectNextString: distinct_word_count=${distinctWordCount} but recent_words is empty for user ${userId}; falling back to min word length`,
            );
            maxLength = MIN_WORD_LENGTH_FLOOR;
          } else if (uniqueInAddWindow >= MIN_UNIQUE_WORDS_FOR_PROGRESS) {
            maxLength = base + 1;
          } else if (uniqueInKeepWindow >= MIN_UNIQUE_WORDS_FOR_PROGRESS) {
            maxLength = base;
          } else {
            maxLength = base - 1;
          }
          // Entering the sentence band always lands on level 8: the
          // accelerator must never skip the short-passage levels
          // (7 + 3 → 8, not 10; 6 + 3 → 8, not 9). Sentence-band
          // progression (base ≥ 8, the branch above) is untouched.
          maxLength = Math.min(maxLength, SENTENCE_LEVEL_THRESHOLD + 1);
          span.setAttribute('pp.lesson.word.accelerated', accelerate);
        }
        maxLength = Math.max(maxLength, MIN_WORD_LENGTH_FLOOR);
        maxLength = Math.min(maxLength, MAX_LESSON_LEVEL);
        maxLength = Math.min(maxLength, effectiveMaxLessonLevel());
        span.setAttribute('pp.lesson.word.max_length', maxLength);
        span.setAttribute('pp.lesson.word.prev_level', prevLevel ?? -1);

        // Passage lesson: a random ready reading passage at the student's
        // level (media_details.level, set from word count at seeding time),
        // excluding recently-lessoned passages. Falls back to the nearest
        // level, then to a level-7 word lesson when no passage exists at all.
        if (maxLength > SENTENCE_LEVEL_THRESHOLD) {
          const passage = await this.selectPassage(
            maxLength,
            data.recent_passage_ids ?? [],
          );
          if (passage) {
            const sentence = splitLessonWords(passage.text);
            span.setAttribute('pp.lesson.word.selection', 'passage');
            span.setAttribute('pp.lesson.passage_id', passage.id);
            span.setAttribute('pp.lesson.word.count', sentence.length);
            span.setAttribute('pp.lesson.passage.reused', passage.reused);
            if (passage.reused) {
              // Every passage at every lesson level has been assigned to this
              // student already — seed more; least-recently-seen is served.
              this.logger.warn(
                `selectNextString: passage bank exhausted at level ${String(maxLength)} — reusing ${passage.id} (user on the span)`,
              );
            }
            this.logger.log(
              `selectNextString: passage=${passage.id} level=${String(maxLength)} words=${String(sentence.length)}`,
            );
            return {
              word: '',
              sentence,
              level: maxLength,
              passageId: passage.id,
              passageLevel: passage.level,
            };
          }
          this.logger.warn(
            `selectNextString: no ready reading passage for level ${maxLength} — falling back to a word lesson at level ${SENTENCE_LEVEL_THRESHOLD}`,
          );
          span.setAttribute(
            'pp.lesson.word.selection',
            'passage-missing-word-fallback',
          );
          maxLength = SENTENCE_LEVEL_THRESHOLD;
        }

        // Filter by length
        candidates = candidates.filter(
          (w) => Array.from(w).length <= maxLength,
        );

        // Baseline = mean of "reviewed" letter scores. Seed values arrive in
        // 0.5 increments; live grading uses non-half deltas (e.g. ±1.01,
        // ±3.001), so a score that is NOT a multiple of 0.5 indicates the
        // letter has actually been graded. Baseline shifts difficulty to be
        // measured relative to the user's current ability.
        const reviewedScores: number[] = [];
        for (const score of scoreMap.values()) {
          if (!Number.isInteger(score * 2)) {
            reviewedScores.push(score);
          }
        }
        const baseline =
          reviewedScores.length === 0
            ? 0
            : reviewedScores.reduce((sum, v) => sum + v, 0) /
              reviewedScores.length;
        span.setAttribute('pp.lesson.word.baseline', baseline);
        span.setAttribute(
          'pp.lesson.word.reviewed_count',
          reviewedScores.length,
        );

        // Score each word: reviewed letters use (raw − baseline); seed letters
        // keep their raw score; unknown letters contribute 0 (and trigger a
        // single WARN below).
        const unknownGraphemes = new Set<string>();
        const scored = candidates.map((word) => {
          const wordScore = Array.from(word).reduce((sum, char) => {
            const score = scoreMap.get(char);
            if (score === undefined) {
              unknownGraphemes.add(char);
              return sum;
            }
            if (Number.isInteger(score * 2)) {
              return sum + score;
            }
            return sum + (score - baseline);
          }, 0);
          return { word, wordScore };
        });

        if (unknownGraphemes.size > 0) {
          this.logger.warn(
            `selectNextString: ${unknownGraphemes.size} unknown grapheme(s) for user ${userId}: [${Array.from(unknownGraphemes).join(', ')}]`,
          );
        }

        // Safety fallback
        if (scored.length === 0) {
          this.logger.warn(
            'selectNextString: no candidates after filtering — falling back to random two-letter word',
          );
          const twoLetterWords = this.wordList.filter(
            (w) => Array.from(w).length === 2,
          );
          const fallbackWord =
            twoLetterWords[Math.floor(Math.random() * twoLetterWords.length)];
          span.setAttribute(
            'pp.lesson.word.selection',
            'fallback-random-two-letter',
          );
          span.setAttribute('pp.lesson.word.selected', fallbackWord);
          return {
            word: fallbackWord,
            sentence: null,
            level: maxLength,
            passageId: null,
            passageLevel: null,
          };
        }

        // Tie-break: minimum score → longest grapheme count → random.
        const SCORE_EPS = 1e-9;
        const minScore = Math.min(...scored.map((s) => s.wordScore));
        const minTies = scored.filter(
          (s) => Math.abs(s.wordScore - minScore) < SCORE_EPS,
        );
        const maxLen = Math.max(
          ...minTies.map((s) => Array.from(s.word).length),
        );
        const longestTies = minTies.filter(
          (s) => Array.from(s.word).length === maxLen,
        );
        const selected =
          longestTies[Math.floor(Math.random() * longestTies.length)].word;

        const topFive = [...scored]
          .sort((a, b) => a.wordScore - b.wordScore)
          .slice(0, 5)
          .map((s) => `${s.word}=${s.wordScore.toFixed(3)}`)
          .join(', ');

        span.setAttribute(
          'pp.lesson.word.selection',
          'min-score-longest-tie-break',
        );
        span.setAttribute('pp.lesson.word.selected', selected);
        span.setAttribute(
          'pp.lesson.word.unique_in_add_window',
          uniqueInAddWindow,
        );
        span.setAttribute(
          'pp.lesson.word.unique_in_keep_window',
          uniqueInKeepWindow,
        );
        span.setAttribute('pp.lesson.word.top_5', topFive);

        this.logger.log(
          `selectNextString: selected=${selected} max_length=${String(maxLength)} baseline=${baseline.toFixed(3)} reviewed=${String(reviewedScores.length)} unique_in_add_window=${String(uniqueInAddWindow)} unique_in_keep_window=${String(uniqueInKeepWindow)} candidates=${String(scored.length)} top5=[${topFive}]`,
        );
        return {
          word: selected,
          sentence: null,
          level: maxLength,
          passageId: null,
          passageLevel: null,
        };
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
