import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  Score,
  CreateScoreOptions,
  FindScoreOptions,
  GradeAndRecordOptions,
  DEFAULT_FIND_SCORE_LIMIT,
  validateCreateScoreOptions,
  validateFindScoreOptions,
  validateGradeAndRecordOptions,
} from './score.dto';
import { User } from '../../users/user.dto';
import { Letter } from '../letters/letter.dto';

function buildUserWhere(
  o: Record<string, unknown>,
  alias: string,
  params: unknown[],
  startIdx: number,
): { clause: string; nextIdx: number } {
  if (o.user) {
    params.push((o.user as User).id);
    return {
      clause: `${alias}.id = $${startIdx}`,
      nextIdx: startIdx + 1,
    };
  }
  if (o.user_id) {
    params.push(o.user_id);
    return {
      clause: `${alias}.id = $${startIdx}`,
      nextIdx: startIdx + 1,
    };
  }
  params.push(o.user_external_id);
  return {
    clause: `${alias}.external_id = $${startIdx}`,
    nextIdx: startIdx + 1,
  };
}

function buildLetterWhere(
  o: Record<string, unknown>,
  alias: string,
  params: unknown[],
  startIdx: number,
): { clause: string; nextIdx: number } {
  if (o.letter) {
    params.push((o.letter as Letter).id);
    return {
      clause: `${alias}.id = $${startIdx}`,
      nextIdx: startIdx + 1,
    };
  }
  if (o.letter_id) {
    params.push(o.letter_id);
    return {
      clause: `${alias}.id = $${startIdx}`,
      nextIdx: startIdx + 1,
    };
  }
  params.push(o.letter_grapheme);
  return {
    clause: `${alias}.grapheme = $${startIdx}`,
    nextIdx: startIdx + 1,
  };
}

function calculateNewScore(
  average: number,
  previousScore: number | undefined,
  correct: boolean,
): number {
  const base = previousScore ?? 0;
  return correct ? base + 1.01 : base - 5.01;
}

@Injectable()
export class ScoreService {
  private readonly logger = new Logger(ScoreService.name);

  constructor(private readonly dataSource: DataSource) {}

  async create(options: CreateScoreOptions): Promise<Score> {
    const validated = validateCreateScoreOptions(options);
    const o = validated as unknown as Record<string, unknown>;
    const params: unknown[] = [];
    let idx = 1;

    const userWhere = buildUserWhere(o, 'u', params, idx);
    idx = userWhere.nextIdx;

    const letterWhere = buildLetterWhere(o, 'l', params, idx);
    idx = letterWhere.nextIdx;

    params.push(validated.user_message_id);
    const umIdx = idx++;
    params.push(validated.score);
    const scoreIdx = idx++;

    const rows = await this.dataSource.query(
      `INSERT INTO scores (user_id, letter_id, user_message_id, score)
       SELECT u.id, l.id, $${umIdx}, $${scoreIdx}
       FROM users u, letters l, media_metadata m
       WHERE ${userWhere.clause} AND ${letterWhere.clause}
         AND m.id = $${umIdx} AND m.rolled_back = false
       RETURNING *`,
      params,
    );

    if (rows.length === 0) {
      throw new NotFoundException(
        'create() referenced user, letter, or media_metadata not found (or rolled back)',
      );
    }
    return rows[0];
  }

  async find(options: FindScoreOptions): Promise<Score[]> {
    const validated = validateFindScoreOptions(options);
    const o = validated as unknown as Record<string, unknown>;

    const whereClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    let fromClause = 'scores s';

    const hasUser =
      o.user !== undefined ||
      o.user_id !== undefined ||
      o.user_external_id !== undefined;
    const hasLetter =
      o.letter !== undefined ||
      o.letter_id !== undefined ||
      o.letter_grapheme !== undefined;

    if (hasUser) {
      if (o.user) {
        params.push((o.user as User).id);
        whereClauses.push(`s.user_id = $${idx++}`);
      } else if (o.user_id) {
        params.push(o.user_id);
        whereClauses.push(`s.user_id = $${idx++}`);
      } else {
        fromClause += ', users u';
        params.push(o.user_external_id);
        whereClauses.push(`u.external_id = $${idx++}`);
        whereClauses.push('s.user_id = u.id');
      }
    }

    if (hasLetter) {
      if (o.letter) {
        params.push((o.letter as Letter).id);
        whereClauses.push(`s.letter_id = $${idx++}`);
      } else if (o.letter_id) {
        params.push(o.letter_id);
        whereClauses.push(`s.letter_id = $${idx++}`);
      } else {
        fromClause += ', letters l';
        params.push(o.letter_grapheme);
        whereClauses.push(`l.grapheme = $${idx++}`);
        whereClauses.push('s.letter_id = l.id');
      }
    }

    const limit = validated.limit ?? DEFAULT_FIND_SCORE_LIMIT;
    params.push(limit);
    const limitIdx = idx++;

    const whereStr =
      whereClauses.length > 0
        ? `WHERE ${whereClauses.join(' AND ')}`
        : '';

    const rows = await this.dataSource.query(
      `SELECT s.* FROM ${fromClause} ${whereStr}
       ORDER BY s.created_at DESC LIMIT $${limitIdx}`,
      params,
    );
    return rows;
  }

  async gradeAndRecord(
    options: GradeAndRecordOptions,
  ): Promise<Score[]> {
    const validated = validateGradeAndRecordOptions(options);
    const { _correct, _incorrect } = validated;

    // DB hit 1 — fetch all scores for this user
    const allScores = await this.find({
      user: validated.user,
      user_id: validated.user_id,
      user_external_id: validated.user_external_id,
    } as FindScoreOptions);

    // Extract most recent score per letter_id
    const latestPerLetter = new Map<string, Score>();
    for (const s of allScores) {
      if (!latestPerLetter.has(s.letter_id)) {
        latestPerLetter.set(s.letter_id, s);
      }
    }

    // Keep only non-integer scores
    const nonIntegerScores = new Map<string, number>();
    // We also need a way to map grapheme -> letter_id for lookup
    // Fetch letter graphemes for the letter_ids in the map
    const letterIds = [...latestPerLetter.keys()];
    const graphemeToScore = new Map<string, number>();

    if (letterIds.length > 0) {
      const placeholders = letterIds.map((_, i) => `$${i + 1}`).join(',');
      const letterRows = await this.dataSource.query(
        `SELECT id, grapheme FROM letters WHERE id IN (${placeholders})`,
        letterIds,
      );
      const idToGrapheme = new Map<string, string>(
        letterRows.map((r: { id: string; grapheme: string }) => [r.id, r.grapheme]),
      );

      for (const [letterId, score] of latestPerLetter) {
        if (score.score % 1 !== 0) {
          const grapheme = idToGrapheme.get(letterId);
          if (grapheme) {
            nonIntegerScores.set(grapheme, score.score);
            graphemeToScore.set(grapheme, score.score);
          }
        }
      }
    }

    // Compute average of non-integer scores
    const nonIntValues = [...nonIntegerScores.values()];
    const average =
      nonIntValues.length > 0
        ? nonIntValues.reduce((a, b) => a + b, 0) / nonIntValues.length
        : 0.001;

    // Build score entries
    const allGraphemes: { grapheme: string; isCorrect: boolean }[] = [];
    for (const g of _correct) {
      allGraphemes.push({ grapheme: g, isCorrect: true });
    }
    for (const g of _incorrect) {
      allGraphemes.push({ grapheme: g, isCorrect: false });
    }

    if (allGraphemes.length === 0) return [];

    // Compute new scores
    const newScores = allGraphemes.map(({ grapheme, isCorrect }) => {
      const previousScore = graphemeToScore.get(grapheme);
      return {
        grapheme,
        score: calculateNewScore(average, previousScore, isCorrect),
      };
    });

    // DB hit 2 — single multi-row INSERT
    const userRef = validated.user
      ? { clause: 'u.id = $1', param: (validated.user as User).id }
      : validated.user_id
        ? { clause: 'u.id = $1', param: validated.user_id }
        : {
            clause: 'u.external_id = $1',
            param: validated.user_external_id,
          };

    const params: unknown[] = [userRef.param, validated.userMessageId];
    let idx = 3;
    const selectParts: string[] = [];

    for (const entry of newScores) {
      params.push(entry.grapheme, entry.score);
      selectParts.push(
        `SELECT u.id AS user_id, l.id AS letter_id, $2 AS user_message_id, $${idx + 1}::double precision AS score
         FROM users u, letters l, media_metadata m
         WHERE ${userRef.clause} AND l.grapheme = $${idx}
           AND m.id = $2 AND m.rolled_back = false`,
      );
      idx += 2;
    }

    const unionQuery = selectParts.join('\nUNION ALL\n');
    const rows = await this.dataSource.query(
      `INSERT INTO scores (user_id, letter_id, user_message_id, score)
       ${unionQuery}
       RETURNING *`,
      params,
    );

    if (rows.length === 0 && allGraphemes.length > 0) {
      this.logger.warn(
        `gradeAndRecord: no rows inserted — media ${validated.userMessageId} may have been rolled back`,
      );
      return [];
    }

    return rows;
  }
}
