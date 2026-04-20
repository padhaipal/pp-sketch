import { BadRequestException } from '@nestjs/common';

export interface Letter {
  id: string;
  grapheme: string;
  media_metadata_id?: string | null;
  created_at: Date;
}

export interface CreateLetterOptions {
  grapheme: string;
  media_metadata_id?: string | null;
}

export interface CreateBulkLetterOptions {
  items: CreateLetterOptions[];
}

export interface UpdateLetterOptions {
  grapheme: string;
  new_grapheme?: string;
  new_media_metadata_id?: string | null;
}

export interface DeleteLetterOptions {
  grapheme: string;
}

export function validateCreateLetterOptions(raw: unknown): CreateLetterOptions {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestException('createLetter() options must be an object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.grapheme !== 'string' || o.grapheme.length === 0) {
    throw new BadRequestException(
      'createLetter() options.grapheme is required and must be a non-empty string',
    );
  }
  if (
    o.media_metadata_id !== undefined &&
    o.media_metadata_id !== null &&
    (typeof o.media_metadata_id !== 'string' ||
      o.media_metadata_id.length === 0)
  ) {
    throw new BadRequestException(
      'createLetter() options.media_metadata_id must be a non-empty string or null',
    );
  }
  return {
    grapheme: o.grapheme,
    media_metadata_id: o.media_metadata_id,
  };
}

export function validateCreateBulkLetterOptions(
  raw: unknown,
): CreateBulkLetterOptions {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestException('createBulk() options must be an object');
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.items) || o.items.length === 0) {
    throw new BadRequestException(
      'createBulk() options.items must be a non-empty array',
    );
  }
  const items = o.items.map((item: unknown) =>
    validateCreateLetterOptions(item),
  );
  return { items };
}

export function validateUpdateLetterOptions(raw: unknown): UpdateLetterOptions {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestException('updateLetter() options must be an object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.grapheme !== 'string' || o.grapheme.length === 0) {
    throw new BadRequestException(
      'updateLetter() options.grapheme is required and must be a non-empty string',
    );
  }
  if (
    o.new_grapheme !== undefined &&
    (typeof o.new_grapheme !== 'string' || o.new_grapheme.length === 0)
  ) {
    throw new BadRequestException(
      'updateLetter() options.new_grapheme must be a non-empty string',
    );
  }
  if (
    o.new_media_metadata_id !== undefined &&
    o.new_media_metadata_id !== null &&
    (typeof o.new_media_metadata_id !== 'string' ||
      o.new_media_metadata_id.length === 0)
  ) {
    throw new BadRequestException(
      'updateLetter() options.new_media_metadata_id must be a non-empty string or null',
    );
  }
  if (o.new_grapheme === undefined && o.new_media_metadata_id === undefined) {
    throw new BadRequestException(
      'updateLetter() requires at least one of new_grapheme or new_media_metadata_id',
    );
  }
  return {
    grapheme: o.grapheme,
    new_grapheme: o.new_grapheme,
    new_media_metadata_id: o.new_media_metadata_id,
  };
}

export function validateDeleteLetterOptions(raw: unknown): DeleteLetterOptions {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestException('deleteLetter() options must be an object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.grapheme !== 'string' || o.grapheme.length === 0) {
    throw new BadRequestException(
      'deleteLetter() options.grapheme is required and must be a non-empty string',
    );
  }
  return { grapheme: o.grapheme };
}
