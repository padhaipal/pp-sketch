import { BadRequestException } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ArrayMinSize, IsArray, IsString } from 'class-validator';
import { User } from '../../users/user.dto';
import { Letter } from '../letters/letter.dto';

export interface Score {
  id: string;
  user_id: string;
  letter_id: string;
  user_message_id: string | null;
  score: number;
  created_at: Date;
}

type UserRef =
  | { user: User; user_id?: never; user_external_id?: never }
  | { user?: never; user_id: string; user_external_id?: never }
  | { user?: never; user_id?: never; user_external_id: string };

type LetterRef =
  | { letter: Letter; letter_id?: never; letter_grapheme?: never }
  | { letter?: never; letter_id: string; letter_grapheme?: never }
  | { letter?: never; letter_id?: never; letter_grapheme: string };

export type CreateScoreOptions = {
  score: number;
  user_message_id: string;
} & UserRef &
  LetterRef;

type LetterOutcomes = string | string[];

export type GradeAndRecordOptions = UserRef & {
  correct?: LetterOutcomes;
  incorrect?: LetterOutcomes;
  userMessageId: string;
};

type OptionalUserRef =
  | { user: User; user_id?: never; user_external_id?: never }
  | { user?: never; user_id: string; user_external_id?: never }
  | { user?: never; user_id?: never; user_external_id: string }
  | { user?: never; user_id?: never; user_external_id?: never };

type OptionalLetterRef =
  | { letter: Letter; letter_id?: never; letter_grapheme?: never }
  | { letter?: never; letter_id: string; letter_grapheme?: never }
  | { letter?: never; letter_id?: never; letter_grapheme: string }
  | { letter?: never; letter_id?: never; letter_grapheme?: never };

export type FindScoreOptions = { limit?: number } & OptionalUserRef &
  OptionalLetterRef;

export const DEFAULT_FIND_SCORE_LIMIT = 100_000;

function exactlyOne(fields: Record<string, unknown>, _label: string): void {
  const provided = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (provided.length !== 1) {
    const names = Object.keys(fields).join(', ');
    throw new BadRequestException(
      `create() requires exactly one of ${names} (got ${provided.length === 0 ? 'none' : provided.map(([k]) => k).join(', ')})`,
    );
  }
}

function atMostOne(fields: Record<string, unknown>, methodName: string): void {
  const provided = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (provided.length > 1) {
    const names = Object.keys(fields).join(', ');
    throw new BadRequestException(
      `${methodName} requires at most one of ${names} (got ${provided.map(([k]) => k).join(', ')})`,
    );
  }
}

function validateUserRefFields(
  o: Record<string, unknown>,
  methodName: string,
): void {
  if (
    o.user !== undefined &&
    (typeof o.user !== 'object' ||
      o.user === null ||
      typeof (o.user as User).id !== 'string')
  ) {
    throw new BadRequestException(
      `${methodName} options.user must be a User object with a valid id`,
    );
  }
  if (o.user_id !== undefined && typeof o.user_id !== 'string') {
    throw new BadRequestException(
      `${methodName} options.user_id must be a string`,
    );
  }
  if (
    o.user_external_id !== undefined &&
    typeof o.user_external_id !== 'string'
  ) {
    throw new BadRequestException(
      `${methodName} options.user_external_id must be a string`,
    );
  }
}

function validateLetterRefFields(
  o: Record<string, unknown>,
  methodName: string,
): void {
  if (
    o.letter !== undefined &&
    (typeof o.letter !== 'object' ||
      o.letter === null ||
      typeof (o.letter as Letter).id !== 'string')
  ) {
    throw new BadRequestException(
      `${methodName} options.letter must be a Letter object with a valid id`,
    );
  }
  if (o.letter_id !== undefined && typeof o.letter_id !== 'string') {
    throw new BadRequestException(
      `${methodName} options.letter_id must be a string`,
    );
  }
  if (
    o.letter_grapheme !== undefined &&
    typeof o.letter_grapheme !== 'string'
  ) {
    throw new BadRequestException(
      `${methodName} options.letter_grapheme must be a string`,
    );
  }
}

export function validateCreateScoreOptions(
  options: unknown,
): CreateScoreOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('create() options must be an object');
  }
  const o = options as Record<string, unknown>;

  if (typeof o.score !== 'number' || !Number.isFinite(o.score)) {
    throw new BadRequestException(
      'create() options.score is required and must be a finite number',
    );
  }

  if (typeof o.user_message_id !== 'string' || o.user_message_id.length === 0) {
    throw new BadRequestException(
      'create() options.user_message_id is required and must be a non-empty string',
    );
  }

  exactlyOne(
    { user: o.user, user_id: o.user_id, user_external_id: o.user_external_id },
    'user ref',
  );
  exactlyOne(
    {
      letter: o.letter,
      letter_id: o.letter_id,
      letter_grapheme: o.letter_grapheme,
    },
    'letter ref',
  );
  validateUserRefFields(o, 'create()');
  validateLetterRefFields(o, 'create()');

  return o as unknown as CreateScoreOptions;
}

export function validateFindScoreOptions(options: unknown): FindScoreOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('find() options must be an object');
  }
  const o = options as Record<string, unknown>;

  if (o.limit !== undefined) {
    if (
      typeof o.limit !== 'number' ||
      !Number.isInteger(o.limit) ||
      o.limit < 1
    ) {
      throw new BadRequestException(
        'find() options.limit must be a positive integer',
      );
    }
    if (o.limit > DEFAULT_FIND_SCORE_LIMIT) {
      throw new BadRequestException(
        `find() options.limit must not exceed ${DEFAULT_FIND_SCORE_LIMIT}`,
      );
    }
  }

  atMostOne(
    { user: o.user, user_id: o.user_id, user_external_id: o.user_external_id },
    'find()',
  );
  atMostOne(
    {
      letter: o.letter,
      letter_id: o.letter_id,
      letter_grapheme: o.letter_grapheme,
    },
    'find()',
  );
  validateUserRefFields(o, 'find()');
  validateLetterRefFields(o, 'find()');

  return o as unknown as FindScoreOptions;
}

function validateLetterOutcomes(value: unknown, fieldName: string): string[] {
  if (typeof value === 'string') {
    if (value.length === 0) {
      throw new BadRequestException(
        `gradeAndRecord() options.${fieldName} must be a non-empty string`,
      );
    }
    return [value];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new BadRequestException(
        `gradeAndRecord() options.${fieldName} array must not be empty`,
      );
    }
    for (const item of value) {
      if (typeof item !== 'string' || item.length === 0) {
        throw new BadRequestException(
          `gradeAndRecord() options.${fieldName} array items must be non-empty strings`,
        );
      }
    }
    return value;
  }
  throw new BadRequestException(
    `gradeAndRecord() options.${fieldName} must be a string or array of strings`,
  );
}

// Per-letter bucketing returned by ScoreService.getLetterBins.
//   untouched : letters with 0–1 score rows for the user, OR with rows but no
//               seed (user_message_id IS NULL) — i.e. nothing meaningful to score.
//   regressed : last_score <= seed_score (got worse, or back to neutral).
//   learnt    : last_score > seed_score AND n_scores >= 4 AND
//               min_score <= seed_score - 4. Mirrors the "≥ 4 scores + dipped
//               ≥ 4 below seed + recovered above" rule of the previous
//               getLettersLearnt — that's the source of truth for the magic 4s.
//   improved  : last_score > seed_score, but doesn't qualify for `learnt`
//               (never dipped 4 below seed, or didn't accumulate ≥ 4 scores).
// Bins are disjoint and exhaustive over letters in the `letters` table for
// the given user.
export interface LetterBins {
  untouched: string[];
  regressed: string[];
  learnt: string[];
  improved: string[];
}

export interface LetterBinsResult {
  userId: string;
  userPhone: string;
  bins: LetterBins;
}

export class LetterBinsQueryDto {
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
    }
    if (Array.isArray(value)) {
      return value.flatMap((s: string) =>
        s
          .split(',')
          .map((t: string) => t.trim())
          .filter((t: string) => t.length > 0),
      );
    }
    return value;
  })
  @IsArray()
  @ArrayMinSize(1, {
    message: 'users must contain at least one user identifier',
  })
  @IsString({ each: true, message: 'each user identifier must be a string' })
  users: string[];
}

export function validateLetterBinsInput(users: unknown): string[] {
  if (typeof users === 'string') {
    if (users.length === 0) {
      throw new BadRequestException(
        'getLetterBins() users must be a non-empty string',
      );
    }
    return [users];
  }
  if (Array.isArray(users)) {
    if (users.length === 0) {
      throw new BadRequestException(
        'getLetterBins() users array must not be empty',
      );
    }
    for (const item of users) {
      if (typeof item !== 'string' || item.length === 0) {
        throw new BadRequestException(
          'getLetterBins() users array items must be non-empty strings',
        );
      }
    }
    return users;
  }
  throw new BadRequestException(
    'getLetterBins() users must be a string or array of strings',
  );
}

export function validateGradeAndRecordOptions(
  options: unknown,
): GradeAndRecordOptions & { _correct: string[]; _incorrect: string[] } {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('gradeAndRecord() options must be an object');
  }
  const o = options as Record<string, unknown>;

  exactlyOne(
    { user: o.user, user_id: o.user_id, user_external_id: o.user_external_id },
    'user ref',
  );
  validateUserRefFields(o, 'gradeAndRecord()');

  if (typeof o.userMessageId !== 'string' || o.userMessageId.length === 0) {
    throw new BadRequestException(
      'gradeAndRecord() options.userMessageId is required and must be a non-empty string',
    );
  }

  if (o.correct === undefined && o.incorrect === undefined) {
    throw new BadRequestException(
      'gradeAndRecord() requires at least one of correct or incorrect',
    );
  }

  const _correct =
    o.correct !== undefined ? validateLetterOutcomes(o.correct, 'correct') : [];
  const _incorrect =
    o.incorrect !== undefined
      ? validateLetterOutcomes(o.incorrect, 'incorrect')
      : [];

  return {
    ...(o as unknown as GradeAndRecordOptions),
    _correct,
    _incorrect,
  };
}
