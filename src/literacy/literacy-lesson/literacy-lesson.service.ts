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
  LiteracyLessonState,
  ProcessAnswerOptions,
  ProcessAnswerResult,
  validateProcessAnswerOptions,
} from './literacy-lesson.dto';

const RECENT_WORDS_TO_EXCLUDE = 5;
const SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH = 8;
const SNAPSHOT_THRESHOLD_KEEP_WORD_LENGTH_SAME = 15;
const MIN_UNIQUE_WORDS_FOR_PROGRESS = 3;
const MIN_WORD_LENGTH_FLOOR = 2;
const NEW_USER_THRESHOLD = 3;

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
    this.wordList = JSON.parse(fs.readFileSync(wordListPath, 'utf-8'));
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
        if (validated.transcripts && validated.transcripts.length > 0) {
          combinedTranscript = validated.transcripts
            .map((t) => t.text ?? '')
            .join(' ');
        }

        // 3. Find current state
        const currentState = await this.findCurrentState(validated.user.id);

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
          if (age > 900_000) {
            startFresh = true;
            lessonPath = 'fresh';
          } else if (age > 60_000) {
            startFresh = true;
            isStaleRestart = true;
            lessonPath = 'stale-restart';
          } else if (currentState.snapshot?.status === 'done') {
            startFresh = true;
            lessonPath = 'complete-restart';
          }
        }
        span.setAttribute('pp.lesson.path', lessonPath);

        let snapshot: any;

        if (startFresh) {
          // 5. Start a new lesson
          const word = await this.selectNextWord(validated.user.id);
          const actor = createActor(machine, {
            input: { word, userMessageId: validated.user_message_id },
          });
          actor.start();

          snapshot = actor.getSnapshot();
          actor.stop();
        } else {
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
          };

          const actor = createActor(machine, {
            snapshot: restoredSnapshot,
            input: { word: '', userMessageId: '' },
          });
          actor.start();

          actor.send({
            type: 'ANSWER',
            studentAnswer: combinedTranscript,
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
        const rows = await this.dataSource.query(
          `INSERT INTO literacy_lesson_states (user_id, user_message_id, word, answer, answer_correct, snapshot, created_at)
           SELECT $1, $2, $3, $4, $5, $6, now()
           FROM media_metadata m
           WHERE m.id = $2 AND m.rolled_back = false
           RETURNING *`,
          [
            validated.user.id,
            validated.user_message_id,
            snapshot.context.word,
            answer,
            answerCorrect,
            JSON.stringify(snapshot),
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

        return {
          stateTransitionIds,
          isComplete,
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

  async findCurrentState(userId: string): Promise<LiteracyLessonState | null> {
    const entity = await this.lessonStateRepo.findOne({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
    return entity ?? null;
  }

  async cleanupPartialState(userMessageId: string): Promise<void> {
    const { scoresDeleted, statesDeleted } = await this.dataSource.transaction(
      async (manager) => {
        const scoreRows = await manager.query(
          `DELETE FROM scores WHERE user_message_id = $1 RETURNING id`,
          [userMessageId],
        );
        const stateRows = await manager.query(
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

  private async selectNextWord(userId: string): Promise<string> {
    return tracer.startActiveSpan('literacy.selectNextWord', async (span) => {
      span.setAttribute('pp.user.id', userId);
      try {
        // Single DB round-trip
        const rows = await this.dataSource.query(
          `WITH recent_distinct_words AS (
            SELECT word, MAX(created_at) AS latest_at
            FROM literacy_lesson_states
            WHERE user_id = $1
            GROUP BY word
            ORDER BY latest_at DESC
            LIMIT $2
          ),
          recent_rows AS (
            SELECT word, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
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
              (SELECT COUNT(DISTINCT word)::int FROM recent_rows WHERE rn <= $4),
              0
            ) AS unique_in_add_window,
            COALESCE(
              (SELECT COUNT(DISTINCT word)::int FROM recent_rows),
              0
            ) AS unique_in_keep_window,
            COALESCE((SELECT COUNT(*)::int FROM recent_rows), 0) AS recent_row_count,
            COALESCE((SELECT count FROM distinct_word_count), 0) AS distinct_word_count`,
          [
            userId,
            RECENT_WORDS_TO_EXCLUDE,
            SNAPSHOT_THRESHOLD_KEEP_WORD_LENGTH_SAME,
            SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH,
          ],
        );

        const data = rows[0];
        const letterScores: { grapheme: string; score: number }[] =
          data.letter_scores;
        const recentWords: string[] = data.recent_words;
        const uniqueInAddWindow: number = Number(data.unique_in_add_window);
        const uniqueInKeepWindow: number = Number(data.unique_in_keep_window);
        const recentRowCount: number = Number(data.recent_row_count);
        const distinctWordCount: number = Number(data.distinct_word_count);

        // Build score map
        const scoreMap = new Map<string, number>();
        for (const ls of letterScores) {
          scoreMap.set(ls.grapheme, ls.score);
        }

        // Exclude recent words
        const recentSet = new Set(recentWords);
        let candidates = this.wordList.filter((w) => !recentSet.has(w));

        // Determine max word length
        let maxLength: number;
        if (
          distinctWordCount < NEW_USER_THRESHOLD ||
          recentRowCount < SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH
        ) {
          maxLength = MIN_WORD_LENGTH_FLOOR;
        } else {
          if (recentWords.length === 0) {
            this.logger.warn(
              `selectNextWord: distinct_word_count=${distinctWordCount} but recent_words is empty for user ${userId}; falling back to min word length`,
            );
            maxLength = MIN_WORD_LENGTH_FLOOR;
          } else {
            const mostRecentWordLen = Array.from(recentWords[0]).length;
            if (uniqueInAddWindow >= MIN_UNIQUE_WORDS_FOR_PROGRESS) {
              maxLength = mostRecentWordLen + 1;
            } else if (uniqueInKeepWindow >= MIN_UNIQUE_WORDS_FOR_PROGRESS) {
              maxLength = mostRecentWordLen;
            } else {
              maxLength = mostRecentWordLen - 1;
            }
          }
        }
        maxLength = Math.max(maxLength, MIN_WORD_LENGTH_FLOOR);
        span.setAttribute('pp.lesson.word.max_length', maxLength);

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
            `selectNextWord: ${unknownGraphemes.size} unknown grapheme(s) for user ${userId}: [${Array.from(unknownGraphemes).join(', ')}]`,
          );
        }

        // Safety fallback
        if (scored.length === 0) {
          this.logger.warn(
            'selectNextWord: no candidates after filtering — falling back to random two-letter word',
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
          return fallbackWord;
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
          `selectNextWord: selected=${selected} max_length=${String(maxLength)} baseline=${baseline.toFixed(3)} reviewed=${String(reviewedScores.length)} unique_in_add_window=${String(uniqueInAddWindow)} unique_in_keep_window=${String(uniqueInKeepWindow)} candidates=${String(scored.length)} top5=[${topFive}]`,
        );
        return selected;
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
