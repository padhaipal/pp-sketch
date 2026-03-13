```typescript
import { User } from '../../users/user.dto';
import { Letter } from '../letters/letter.dto';

// Matches the pg scores table
export interface Score {
  id: string;                  // UUID PK
  user_id: string;             // FK -> users.id
  letter_id: string;           // FK -> letters.id
  score: number;               // DOUBLE PRECISION
  created_at: Date;            // TIMESTAMPTZ, default now()
}

// --- Options types ---

type UserRef =
  | { user: User;    user_id?: never; user_external_id?: never }
  | { user?: never;  user_id: string; user_external_id?: never }
  | { user?: never;  user_id?: never; user_external_id: string };

type LetterRef =
  | { letter: Letter;  letter_id?: never; letter_grapheme?: never }
  | { letter?: never;  letter_id: string; letter_grapheme?: never }
  | { letter?: never;  letter_id?: never; letter_grapheme: string };

export type CreateScoreOptions = { score: number } & UserRef & LetterRef;

type LetterOutcomes = string | string[];

export type RecordOutcomesOptions = UserRef & {
  correct?: LetterOutcomes;
  incorrect?: LetterOutcomes;
};

type OptionalUserRef =
  | { user: User;    user_id?: never; user_external_id?: never }
  | { user?: never;  user_id: string; user_external_id?: never }
  | { user?: never;  user_id?: never; user_external_id: string }
  | { user?: never;  user_id?: never; user_external_id?: never };

type OptionalLetterRef =
  | { letter: Letter;  letter_id?: never; letter_grapheme?: never }
  | { letter?: never;  letter_id: string; letter_grapheme?: never }
  | { letter?: never;  letter_id?: never; letter_grapheme: string }
  | { letter?: never;  letter_id?: never; letter_grapheme?: never };

export type FindScoreOptions = { limit?: number } & OptionalUserRef & OptionalLetterRef;

export const DEFAULT_FIND_LIMIT = 100_000;

// --- Runtime validation ---

import { BadRequestException } from '@nestjs/common';

function exactlyOne(fields: Record<string, unknown>, label: string): void {
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

function validateUserRefFields(o: Record<string, unknown>, methodName: string): void {
  if (o.user !== undefined && (typeof o.user !== 'object' || o.user === null || typeof (o.user as User).id !== 'string')) {
    throw new BadRequestException(`${methodName} options.user must be a User object with a valid id`);
  }
  if (o.user_id !== undefined && typeof o.user_id !== 'string') {
    throw new BadRequestException(`${methodName} options.user_id must be a string`);
  }
  if (o.user_external_id !== undefined && typeof o.user_external_id !== 'string') {
    throw new BadRequestException(`${methodName} options.user_external_id must be a string`);
  }
}

function validateLetterRefFields(o: Record<string, unknown>, methodName: string): void {
  if (o.letter !== undefined && (typeof o.letter !== 'object' || o.letter === null || typeof (o.letter as Letter).id !== 'string')) {
    throw new BadRequestException(`${methodName} options.letter must be a Letter object with a valid id`);
  }
  if (o.letter_id !== undefined && typeof o.letter_id !== 'string') {
    throw new BadRequestException(`${methodName} options.letter_id must be a string`);
  }
  if (o.letter_grapheme !== undefined && typeof o.letter_grapheme !== 'string') {
    throw new BadRequestException(`${methodName} options.letter_grapheme must be a string`);
  }
}

export function validateCreateScoreOptions(options: unknown): CreateScoreOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('create() options must be an object');
  }
  const o = options as Record<string, unknown>;

  if (typeof o.score !== 'number' || !Number.isFinite(o.score)) {
    throw new BadRequestException('create() options.score is required and must be a finite number');
  }

  exactlyOne({ user: o.user, user_id: o.user_id, user_external_id: o.user_external_id }, 'user ref');
  exactlyOne({ letter: o.letter, letter_id: o.letter_id, letter_grapheme: o.letter_grapheme }, 'letter ref');
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
    if (typeof o.limit !== 'number' || !Number.isInteger(o.limit) || o.limit < 1) {
      throw new BadRequestException('find() options.limit must be a positive integer');
    }
    if (o.limit > DEFAULT_FIND_LIMIT) {
      throw new BadRequestException(`find() options.limit must not exceed ${DEFAULT_FIND_LIMIT}`);
    }
  }

  atMostOne({ user: o.user, user_id: o.user_id, user_external_id: o.user_external_id }, 'find()');
  atMostOne({ letter: o.letter, letter_id: o.letter_id, letter_grapheme: o.letter_grapheme }, 'find()');
  validateUserRefFields(o, 'find()');
  validateLetterRefFields(o, 'find()');

  return o as unknown as FindScoreOptions;
}

function validateLetterOutcomes(value: unknown, fieldName: string): string[] {
  if (typeof value === 'string') {
    if (value.length === 0) {
      throw new BadRequestException(
        `recordOutcomes() options.${fieldName} must be a non-empty string`,
      );
    }
    return [value];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new BadRequestException(
        `recordOutcomes() options.${fieldName} array must not be empty`,
      );
    }
    for (const item of value) {
      if (typeof item !== 'string' || item.length === 0) {
        throw new BadRequestException(
          `recordOutcomes() options.${fieldName} array items must be non-empty strings`,
        );
      }
    }
    return value;
  }
  throw new BadRequestException(
    `recordOutcomes() options.${fieldName} must be a string or array of strings`,
  );
}

export function validateRecordOutcomesOptions(
  options: unknown,
): RecordOutcomesOptions & { _correct: string[]; _incorrect: string[] } {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('recordOutcomes() options must be an object');
  }
  const o = options as Record<string, unknown>;

  exactlyOne(
    { user: o.user, user_id: o.user_id, user_external_id: o.user_external_id },
    'user ref',
  );
  validateUserRefFields(o, 'recordOutcomes()');

  if (o.correct === undefined && o.incorrect === undefined) {
    throw new BadRequestException(
      'recordOutcomes() requires at least one of correct or incorrect',
    );
  }

  const _correct = o.correct !== undefined
    ? validateLetterOutcomes(o.correct, 'correct')
    : [];
  const _incorrect = o.incorrect !== undefined
    ? validateLetterOutcomes(o.incorrect, 'incorrect')
    : [];

  return { ...(o as unknown as RecordOutcomesOptions), _correct, _incorrect };
}
```
