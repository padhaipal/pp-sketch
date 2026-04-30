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
  LetterBins,
  LetterBinsResult,
  DEFAULT_FIND_SCORE_LIMIT,
  validateCreateScoreOptions,
  validateFindScoreOptions,
  validateGradeAndRecordOptions,
  validateLetterBinsInput,
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

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function calculateNewScore(
  _average: number,
  previousScore: number | undefined,
  correct: boolean,
): number {
  const base = previousScore ?? 0;
  return correct ? base + 1.01 : base - 3.001;
}

const SEED_SCORES: { grapheme: string; score: number }[] = [
  { grapheme: 'ऋ', score: 1 },
  { grapheme: 'ा', score: 1.5 },
  { grapheme: 'ी', score: 2 },
  { grapheme: 'ु', score: 2.5 },
  { grapheme: 'े', score: 3 },
  { grapheme: 'ो', score: 3.5 },
  { grapheme: 'ै', score: 4 },
  { grapheme: 'ू', score: 4.5 },
  { grapheme: 'ौ', score: 5 },
  { grapheme: 'ि', score: 5.5 },
  { grapheme: 'ं', score: 6 },
  { grapheme: 'ृ', score: 6.5 },
  { grapheme: 'ञ', score: 7 },
  { grapheme: 'ण', score: 7 },
  { grapheme: 'अ', score: 0 },
  { grapheme: 'आ', score: 0 },
  { grapheme: 'इ', score: 0 },
  { grapheme: 'ई', score: 0 },
  { grapheme: 'उ', score: 0 },
  { grapheme: 'ऊ', score: 0 },
  { grapheme: 'ए', score: 0 },
  { grapheme: 'ऐ', score: 0 },
  { grapheme: 'ओ', score: 0 },
  { grapheme: 'औ', score: 0 },
  { grapheme: 'क', score: 0 },
  { grapheme: 'ख', score: 0 },
  { grapheme: 'ग', score: 0 },
  { grapheme: 'घ', score: 0 },
  { grapheme: 'च', score: 0 },
  { grapheme: 'छ', score: 0 },
  { grapheme: 'ज', score: 0 },
  { grapheme: 'झ', score: 0 },
  { grapheme: 'ट', score: 0 },
  { grapheme: 'ठ', score: 0 },
  { grapheme: 'ड', score: 0 },
  { grapheme: 'ढ', score: 0 },
  { grapheme: 'त', score: 0 },
  { grapheme: 'थ', score: 0 },
  { grapheme: 'द', score: 0 },
  { grapheme: 'ध', score: 0 },
  { grapheme: 'न', score: 0 },
  { grapheme: 'प', score: 0 },
  { grapheme: 'फ', score: 0 },
  { grapheme: 'ब', score: 0 },
  { grapheme: 'भ', score: 0 },
  { grapheme: 'म', score: 0 },
  { grapheme: 'य', score: 0 },
  { grapheme: 'र', score: 0 },
  { grapheme: 'ल', score: 0 },
  { grapheme: 'व', score: 0 },
  { grapheme: 'श', score: 0 },
  { grapheme: 'ष', score: 0 },
  { grapheme: 'स', score: 0 },
  { grapheme: 'ह', score: 0 },
];

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
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const rows = await this.dataSource.query(
      `SELECT s.* FROM ${fromClause} ${whereStr}
       ORDER BY s.created_at DESC LIMIT $${limitIdx}`,
      params,
    );
    return rows;
  }

  async gradeAndRecord(options: GradeAndRecordOptions): Promise<Score[]> {
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

    // Keep only non-integer scores (for average calculation)
    const nonIntegerScores = new Map<string, number>();
    // We also need a way to map grapheme -> latest score for baseline updates.
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
        letterRows.map((r: { id: string; grapheme: string }) => [
          r.id,
          r.grapheme,
        ]),
      );

      for (const [letterId, score] of latestPerLetter) {
        const grapheme = idToGrapheme.get(letterId);
        if (grapheme) {
          // Baseline for calculateNewScore should always be latest known score,
          // including integer values (e.g. -100) to avoid unintended reset to 0.
          graphemeToScore.set(grapheme, score.score);
          if (score.score % 1 !== 0) {
            nonIntegerScores.set(grapheme, score.score);
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
      ? { clause: 'u.id = $1', param: validated.user.id }
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

  async getLetterBins(
    users: string | string[],
    options?: { asOf?: Date },
  ): Promise<LetterBinsResult | LetterBinsResult[]> {
    const isSingleInput = typeof users === 'string';
    const normalized = validateLetterBinsInput(users);
    const asOf = options?.asOf;
    if (asOf !== undefined && Number.isNaN(asOf.getTime())) {
      throw new BadRequestException(
        'getLetterBins() options.asOf must be a valid Date',
      );
    }

    const ids: string[] = [];
    const phones: string[] = [];
    for (const u of normalized) {
      if (UUID_REGEX.test(u)) {
        ids.push(u);
      } else {
        phones.push(u);
      }
    }

    // Resolve all users in a single round-trip.
    const userParams: unknown[] = [];
    const userConditions: string[] = [];
    let idx = 1;

    if (ids.length > 0) {
      const placeholders = ids.map((_, i) => `$${idx + i}`).join(',');
      userParams.push(...ids);
      userConditions.push(`id IN (${placeholders})`);
      idx += ids.length;
    }
    if (phones.length > 0) {
      const placeholders = phones.map((_, i) => `$${idx + i}`).join(',');
      userParams.push(...phones);
      userConditions.push(`external_id IN (${placeholders})`);
      idx += phones.length;
    }

    const userRows: { id: string; external_id: string }[] =
      await this.dataSource.query(
        `SELECT id, external_id FROM users WHERE ${userConditions.join(' OR ')}`,
        userParams,
      );

    const foundById = new Map(userRows.map((u) => [u.id, u]));
    const foundByPhone = new Map(userRows.map((u) => [u.external_id, u]));

    for (const id of ids) {
      if (!foundById.has(id)) {
        throw new NotFoundException(`User not found: ${id}`);
      }
    }
    for (const phone of phones) {
      if (!foundByPhone.has(phone)) {
        throw new NotFoundException(`User not found: ${phone}`);
      }
    }

    const userIds = userRows.map((u) => u.id);

    // Per-(user, letter) aggregates over the score history. CROSS JOIN against
    // letters guarantees a row for every letter in the table even when the
    // user has no scores for it (those rows fall into the "untouched" bin).
    // seed_score is the score from the row with user_message_id IS NULL — set
    // by user.service.ts/createSeedScores at user creation. last_score uses
    // the chronologically most recent row. min_score detects the dip needed
    // for the "learnt" bin (mirrors the magic 4 from the previous
    // getLettersLearnt rule, which is now the source of truth for that
    // threshold).
    const scoreParams: unknown[] = [userIds];
    let asOfClause = '';
    if (asOf !== undefined) {
      scoreParams.push(asOf);
      asOfClause = ' AND s.created_at <= $2';
    }
    const aggRows: {
      user_id: string;
      grapheme: string;
      n_scores: string | number | null;
      seed_score: number | null;
      last_score: number | null;
      min_score: number | null;
    }[] = await this.dataSource.query(
      `WITH per_letter AS (
         SELECT s.user_id, s.letter_id, s.score, s.user_message_id,
                ROW_NUMBER() OVER (
                  PARTITION BY s.user_id, s.letter_id
                  ORDER BY s.created_at DESC
                ) AS rn_last
         FROM scores s
         WHERE s.user_id = ANY($1::uuid[])${asOfClause}
       ),
       agg AS (
         SELECT user_id, letter_id,
                COUNT(*) AS n_scores,
                MAX(score) FILTER (WHERE user_message_id IS NULL) AS seed_score,
                MAX(score) FILTER (WHERE rn_last = 1) AS last_score,
                MIN(score) AS min_score
         FROM per_letter
         GROUP BY user_id, letter_id
       )
       SELECT u.id AS user_id, l.grapheme,
              a.n_scores, a.seed_score, a.last_score, a.min_score
       FROM unnest($1::uuid[]) AS u(id)
       CROSS JOIN letters l
       LEFT JOIN agg a ON a.user_id = u.id AND a.letter_id = l.id`,
      scoreParams,
    );

    // Bucket rows into per-user bins. Priority order matches DTO comment:
    //   untouched → regressed → learnt → improved.
    const perUserBins = new Map<string, LetterBins>();
    for (const userId of userIds) {
      perUserBins.set(userId, {
        untouched: [],
        regressed: [],
        learnt: [],
        improved: [],
      });
    }
    for (const row of aggRows) {
      const bins = perUserBins.get(row.user_id)!;
      const n = row.n_scores === null ? 0 : Number(row.n_scores);
      const seed = row.seed_score;
      const last = row.last_score;
      const min = row.min_score;

      // Bin 1 — never seeded, no scores at all, or only the seed row
      // (n_scores ≤ 1). "Has scores but no seed" also lands here per spec.
      if (seed === null || n <= 1) {
        bins.untouched.push(row.grapheme);
        continue;
      }
      // last/min are guaranteed non-null when n ≥ 1 — narrow for TS.
      if (last === null || min === null) {
        bins.untouched.push(row.grapheme);
        continue;
      }
      // Bin 2 — final ≤ seed (regression or back to neutral).
      if (last <= seed) {
        bins.regressed.push(row.grapheme);
        continue;
      }
      // Bin 3 — final > seed AND ≥ 4 score rows AND dipped ≥ 4 below seed.
      if (n >= 4 && min <= seed - 4) {
        bins.learnt.push(row.grapheme);
        continue;
      }
      // Bin 4 — final > seed but didn't qualify for "learnt".
      bins.improved.push(row.grapheme);
    }

    // Assemble per-input results, preserving caller order, deduping by user id.
    const inputToUser = new Map<string, { id: string; external_id: string }>();
    for (const u of userRows) {
      inputToUser.set(u.id, u);
      inputToUser.set(u.external_id, u);
    }
    const results: LetterBinsResult[] = [];
    const seen = new Set<string>();
    for (const input of normalized) {
      const user = inputToUser.get(input)!;
      if (seen.has(user.id)) continue;
      seen.add(user.id);
      results.push({
        userId: user.id,
        userPhone: user.external_id,
        bins: perUserBins.get(user.id)!,
      });
    }

    return isSingleInput ? results[0] : results;
  }

  async createSeedScores(userId: string): Promise<void> {
    if (SEED_SCORES.length === 0) return;

    const params: unknown[] = [userId];
    const selects: string[] = [];

    for (const { grapheme, score } of SEED_SCORES) {
      const gIdx = params.push(grapheme);
      const sIdx = params.push(score);
      selects.push(
        `SELECT $1::uuid, l.id, $${sIdx}::double precision FROM letters l WHERE l.grapheme = $${gIdx}`,
      );
    }

    const rows = await this.dataSource.query(
      `INSERT INTO scores (user_id, letter_id, score)
       ${selects.join('\n       UNION ALL\n       ')}`,
      params,
    );

    this.logger.log(`Seed scores: inserted ${rows.length} for user ${userId}`);
  }
}
