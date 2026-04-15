import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';
import { createActor } from 'xstate';
import { LiteracyLessonStateEntity } from './literacy-lesson-state.entity';
import { ScoreService } from '../score/score.service';
import { machine } from './literacy-lesson.machine';
import {
  LiteracyLessonState,
  ProcessAnswerOptions,
  ProcessAnswerResult,
  validateProcessAnswerOptions,
} from './literacy-lesson.dto';

const RECENT_WORDS_TO_EXCLUDE = 5;
const SNAPSHOT_WORDS_TO_COUNT = 3;
const SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH = 10;
const SNAPSHOT_THRESHOLD_KEEP_WORD_LENGTH_SAME = 15;
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
    // 1. Validate
    const validated = validateProcessAnswerOptions(options);

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
    if (!currentState) {
      startFresh = true;
    } else {
      const age =
        Date.now() - new Date(currentState.created_at).getTime();
      if (age > 120_000) {
        startFresh = true;
      } else if (currentState.snapshot?.status === 'done') {
        startFresh = true;
      }
    }

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
    const pendingCorrect: string[] =
      snapshot.context.pendingCorrect ?? [];
    const pendingIncorrect: string[] =
      snapshot.context.pendingIncorrect ?? [];

    // 8. Persist snapshot
    const answer: string | null = snapshot.context.answer ?? null;
    const answerCorrect: boolean | null = snapshot.context.answerCorrect ?? null;
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
      this.logger.error(
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
          correct:
            pendingCorrect.length > 0 ? pendingCorrect : undefined,
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
    return {
      stateTransitionId: snapshot.context.stateTransitionId,
      isComplete: snapshot.status === 'done',
    };
  }

  async findCurrentState(
    userId: string,
  ): Promise<LiteracyLessonState | null> {
    const entity = await this.lessonStateRepo.findOne({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
    return entity ?? null;
  }

  private async selectNextWord(userId: string): Promise<string> {
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
      top_n_words AS (
        SELECT word FROM recent_distinct_words
        ORDER BY latest_at DESC
        LIMIT $3
      ),
      top_n_snapshot_count AS (
        SELECT COUNT(*)::int AS count
        FROM literacy_lesson_states
        WHERE user_id = $1 AND word IN (SELECT word FROM top_n_words)
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
        COALESCE((SELECT count FROM top_n_snapshot_count), 0) AS top_n_snapshot_count,
        COALESCE((SELECT count FROM distinct_word_count), 0) AS distinct_word_count`,
      [userId, RECENT_WORDS_TO_EXCLUDE, SNAPSHOT_WORDS_TO_COUNT],
    );

    const data = rows[0];
    const letterScores: { grapheme: string; score: number }[] =
      data.letter_scores;
    const recentWords: string[] = data.recent_words;
    const topNSnapshotCount: number = Number(data.top_n_snapshot_count);
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
    if (distinctWordCount < NEW_USER_THRESHOLD) {
      maxLength = MIN_WORD_LENGTH_FLOOR;
    } else {
      const mostRecentWordLen = Array.from(recentWords[0]).length;
      if (topNSnapshotCount < SNAPSHOT_THRESHOLD_ADD_WORD_LENGTH) {
        maxLength = mostRecentWordLen + 1;
      } else if (
        topNSnapshotCount < SNAPSHOT_THRESHOLD_KEEP_WORD_LENGTH_SAME
      ) {
        maxLength = mostRecentWordLen;
      } else {
        maxLength = mostRecentWordLen - 1;
      }
    }
    maxLength = Math.max(maxLength, MIN_WORD_LENGTH_FLOOR);

    // Filter by length
    candidates = candidates.filter(
      (w) => Array.from(w).length <= maxLength,
    );

    // Score each word
    const scored = candidates.map((word) => {
      const wordScore = Array.from(word).reduce(
        (sum, char) => sum + (scoreMap.get(char) ?? 0),
        0,
      );
      return { word, wordScore };
    });

    // Safety fallback
    if (scored.length === 0) {
      this.logger.warn(
        'selectNextWord: no candidates after filtering — falling back to random word',
      );
      return this.wordList[
        Math.floor(Math.random() * this.wordList.length)
      ];
    }

    // Find minimum score
    const minScore = Math.min(...scored.map((s) => s.wordScore));
    const ties = scored.filter((s) => s.wordScore === minScore);

    // Pick random from ties
    return ties[Math.floor(Math.random() * ties.length)].word;
  }
}
