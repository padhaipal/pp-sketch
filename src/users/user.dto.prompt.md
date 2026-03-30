```typescript
import { BadRequestException } from '@nestjs/common';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Matches the pg users table
export interface User {
  id: string;                      // UUID PK
  external_id: string;             // unique, the user's WhatsApp phone number
  referrer_user_id: string | null; // FK -> users.id
  created_at: Date;                // TIMESTAMPTZ, default now()
}

// --- Options types ---

export interface FindUserOptions {
  id?: string;
  external_id?: string;
}

export interface UpdateUserOptions {
  id?: string;
  external_id?: string;
  new_external_id?: string;
  new_referrer_user_id?: string | null;
  new_referrer_external_id?: string;
}

export interface CreateUserOptions {
  external_id: string;
  referrer_external_id?: string;
  referrer_user_id?: string;
}

// --- E.164 phone validation (WhatsApp convention) ---

function validateE164PhoneNumber(value: string, fieldName: string): string {
  const parsed = parsePhoneNumberFromString(value);
  if (!parsed || !parsed.isValid()) {
    throw new BadRequestException(`${fieldName} must be a valid E.164 phone number (e.g. +923001234567)`);
  }
  return parsed.format('E.164');
}

// --- Runtime validation ---

export function validateFindUserOptions(options: unknown): FindUserOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('find() options must be an object');
  }
  const { id, external_id } = options as Record<string, unknown>;
  if (id !== undefined && typeof id !== 'string') {
    throw new BadRequestException('find() options.id must be a string');
  }
  let validatedExternalId: string | undefined;
  if (external_id !== undefined) {
    if (typeof external_id !== 'string') {
      throw new BadRequestException('find() options.external_id must be a string');
    }
    validatedExternalId = validateE164PhoneNumber(external_id, 'find() options.external_id');
  }
  if (id !== undefined && external_id !== undefined) {
    throw new BadRequestException('find() requires exactly one of id or external_id, not both');
  }
  if (id === undefined && external_id === undefined) {
    throw new BadRequestException('find() requires exactly one of id or external_id');
  }
  return { id, external_id: validatedExternalId } as FindUserOptions;
}

export function validateUpdateUserOptions(options: unknown): UpdateUserOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('update() options must be an object');
  }
  const { id, external_id, new_external_id, new_referrer_user_id, new_referrer_external_id } = options as Record<string, unknown>;
  if (id !== undefined && typeof id !== 'string') {
    throw new BadRequestException('update() options.id must be a string');
  }
  let validatedExternalId: string | undefined;
  if (external_id !== undefined) {
    if (typeof external_id !== 'string') {
      throw new BadRequestException('update() options.external_id must be a string');
    }
    validatedExternalId = validateE164PhoneNumber(external_id, 'update() options.external_id');
  }
  if (id !== undefined && external_id !== undefined) {
    throw new BadRequestException('update() requires exactly one of id or external_id to identify the user, not both');
  }
  if (id === undefined && external_id === undefined) {
    throw new BadRequestException('update() requires exactly one of id or external_id to identify the user');
  }
  let validatedNewExternalId: string | undefined;
  if (new_external_id !== undefined) {
    if (typeof new_external_id !== 'string') {
      throw new BadRequestException('update() options.new_external_id must be a string');
    }
    validatedNewExternalId = validateE164PhoneNumber(new_external_id, 'update() options.new_external_id');
  }
  if (new_referrer_user_id !== undefined && new_referrer_user_id !== null && typeof new_referrer_user_id !== 'string') {
    throw new BadRequestException('update() options.new_referrer_user_id must be a string or null');
  }
  let validatedNewReferrerExternalId: string | undefined;
  if (new_referrer_external_id !== undefined) {
    if (typeof new_referrer_external_id !== 'string') {
      throw new BadRequestException('update() options.new_referrer_external_id must be a string');
    }
    validatedNewReferrerExternalId = validateE164PhoneNumber(new_referrer_external_id, 'update() options.new_referrer_external_id');
  }
  if (new_referrer_user_id !== undefined && new_referrer_external_id !== undefined) {
    throw new BadRequestException('update() requires at most one of new_referrer_user_id or new_referrer_external_id, not both');
  }
  if (new_external_id === undefined && new_referrer_user_id === undefined && new_referrer_external_id === undefined) {
    throw new BadRequestException('update() requires at least one field to update (new_external_id, new_referrer_user_id, new_referrer_external_id)');
  }
  return { id, external_id: validatedExternalId, new_external_id: validatedNewExternalId, new_referrer_user_id, new_referrer_external_id: validatedNewReferrerExternalId } as UpdateUserOptions;
}

export function validateCreateUserOptions(options: unknown): CreateUserOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('create() options must be an object');
  }
  const { external_id, referrer_external_id, referrer_user_id } = options as Record<string, unknown>;
  if (typeof external_id !== 'string') {
    throw new BadRequestException('create() options.external_id is required and must be a string');
  }
  const validatedExternalId = validateE164PhoneNumber(external_id, 'create() options.external_id');
  let validatedReferrerExternalId: string | undefined;
  if (referrer_external_id !== undefined) {
    if (typeof referrer_external_id !== 'string') {
      throw new BadRequestException('create() options.referrer_external_id must be a string');
    }
    validatedReferrerExternalId = validateE164PhoneNumber(referrer_external_id, 'create() options.referrer_external_id');
  }
  if (referrer_user_id !== undefined && typeof referrer_user_id !== 'string') {
    throw new BadRequestException('create() options.referrer_user_id must be a string');
  }
  if (referrer_external_id !== undefined && referrer_user_id !== undefined) {
    throw new BadRequestException('create() requires at most one of referrer_external_id or referrer_user_id, not both');
  }
  return { external_id: validatedExternalId, referrer_external_id: validatedReferrerExternalId, referrer_user_id } as CreateUserOptions;
}
```