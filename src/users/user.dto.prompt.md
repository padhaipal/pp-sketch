```typescript
import { BadRequestException } from '@nestjs/common';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Matches the pg users table. TypeORM entity: src/users/user.entity.ts
export interface User {
  id: string; // UUID PK
  external_id: string; // unique, the user's WhatsApp phone number
  referrer_user_id: string | null; // FK -> users.id
  name: string | null; // optional display name, nullable
  password_hash: string | null; // bcrypt hash, nullable
  role: string | null; // 'admin' | 'dev', nullable
  created_at: Date; // TIMESTAMPTZ, default now()
}

export type UserRole = 'admin' | 'dev';

// --- HTTP DTOs (class-validator decorated) ---

// POST /users/login — authenticate by phone + password
export class LoginDto {
  @IsString() @IsNotEmpty() phone: string;
  @IsString() @IsNotEmpty() password: string;
}

// PATCH /users/:id — update any combination of phone, name, password, role
export class PatchUserDto {
  @IsString() @IsNotEmpty() @IsOptional() phone?: string;
  @IsString() @IsNotEmpty() @IsOptional() name?: string;
  @IsString() @IsNotEmpty() @IsOptional() password?: string;
  @IsIn(['admin', 'dev']) @IsOptional() role?: UserRole;
}

// POST /users/activity-time — for each user × window pair, returns
// the milliseconds the user was "active": the sum of all gaps between
// consecutive whatsapp voice messages the user sent inside that window
// where the gap is < 60 s. Windows may overlap; each is computed
// independently. `users` accepts UUIDs and E.164 phone numbers (sans +).
export class TimeWindowDto {
  @IsISO8601() @IsNotEmpty() start: string;
  @IsISO8601() @IsNotEmpty() end: string;
}
export class ActivityTimeRequestDto {
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) users: string[];
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TimeWindowDto)
  windows: TimeWindowDto[];
}
export interface ActivityTimeWindowResult {
  start: string;
  end: string;
  active_ms: number;
}
export interface ActivityTimeUserResult {
  user_id: string;
  external_id: string;
  windows: ActivityTimeWindowResult[];
}
export interface ActivityTimeResponse {
  results: ActivityTimeUserResult[];
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
  new_name?: string;
  new_referrer_user_id?: string | null;
  new_referrer_external_id?: string;
  // null clears the column (OnboardingService.rollback of a done turn).
  new_birth_year?: number | null;
  new_birth_month?: number | null;
  new_recording_permissions_obtained_at?: Date | null;
}

export interface CreateUserOptions {
  external_id: string;
  name?: string;
  referrer_external_id?: string;
  referrer_user_id?: string;
}

// --- E.164 phone validation (WhatsApp convention) ---

function validateE164PhoneNumber(value: string, fieldName: string): string {
  const parsed = parsePhoneNumberFromString(value);
  if (!parsed || !parsed.isValid()) {
    throw new BadRequestException(
      `${fieldName} must be a valid E.164 phone number (e.g. +923001234567)`,
    );
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
      throw new BadRequestException(
        'find() options.external_id must be a string',
      );
    }
    validatedExternalId = validateE164PhoneNumber(
      external_id,
      'find() options.external_id',
    );
  }
  if (id !== undefined && external_id !== undefined) {
    throw new BadRequestException(
      'find() requires exactly one of id or external_id, not both',
    );
  }
  if (id === undefined && external_id === undefined) {
    throw new BadRequestException(
      'find() requires exactly one of id or external_id',
    );
  }
  return { id, external_id: validatedExternalId } as FindUserOptions;
}

export function validateUpdateUserOptions(options: unknown): UpdateUserOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('update() options must be an object');
  }
  const {
    id,
    external_id,
    new_external_id,
    new_referrer_user_id,
    new_referrer_external_id,
  } = options as Record<string, unknown>;
  if (id !== undefined && typeof id !== 'string') {
    throw new BadRequestException('update() options.id must be a string');
  }
  let validatedExternalId: string | undefined;
  if (external_id !== undefined) {
    if (typeof external_id !== 'string') {
      throw new BadRequestException(
        'update() options.external_id must be a string',
      );
    }
    validatedExternalId = validateE164PhoneNumber(
      external_id,
      'update() options.external_id',
    );
  }
  if (id !== undefined && external_id !== undefined) {
    throw new BadRequestException(
      'update() requires exactly one of id or external_id to identify the user, not both',
    );
  }
  if (id === undefined && external_id === undefined) {
    throw new BadRequestException(
      'update() requires exactly one of id or external_id to identify the user',
    );
  }
  let validatedNewExternalId: string | undefined;
  if (new_external_id !== undefined) {
    if (typeof new_external_id !== 'string') {
      throw new BadRequestException(
        'update() options.new_external_id must be a string',
      );
    }
    validatedNewExternalId = validateE164PhoneNumber(
      new_external_id,
      'update() options.new_external_id',
    );
  }
  if (
    new_referrer_user_id !== undefined &&
    new_referrer_user_id !== null &&
    typeof new_referrer_user_id !== 'string'
  ) {
    throw new BadRequestException(
      'update() options.new_referrer_user_id must be a string or null',
    );
  }
  let validatedNewReferrerExternalId: string | undefined;
  if (new_referrer_external_id !== undefined) {
    if (typeof new_referrer_external_id !== 'string') {
      throw new BadRequestException(
        'update() options.new_referrer_external_id must be a string',
      );
    }
    validatedNewReferrerExternalId = validateE164PhoneNumber(
      new_referrer_external_id,
      'update() options.new_referrer_external_id',
    );
  }
  if (
    new_referrer_user_id !== undefined &&
    new_referrer_external_id !== undefined
  ) {
    throw new BadRequestException(
      'update() requires at most one of new_referrer_user_id or new_referrer_external_id, not both',
    );
  }
  if (
    new_external_id === undefined &&
    new_name === undefined &&
    new_referrer_user_id === undefined &&
    new_referrer_external_id === undefined
  ) {
    throw new BadRequestException(
      'update() requires at least one field to update (new_external_id, new_name, new_referrer_user_id, new_referrer_external_id, new_birth_year, new_birth_month, new_recording_permissions_obtained_at)',
    );
  }
  return {
    id,
    external_id: validatedExternalId,
    new_external_id: validatedNewExternalId,
    new_referrer_user_id,
    new_referrer_external_id: validatedNewReferrerExternalId,
  } as UpdateUserOptions;
}

export function validateCreateUserOptions(options: unknown): CreateUserOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('create() options must be an object');
  }
  const { external_id, referrer_external_id, referrer_user_id } =
    options as Record<string, unknown>;
  if (typeof external_id !== 'string') {
    throw new BadRequestException(
      'create() options.external_id is required and must be a string',
    );
  }
  const validatedExternalId = validateE164PhoneNumber(
    external_id,
    'create() options.external_id',
  );
  let validatedReferrerExternalId: string | undefined;
  if (referrer_external_id !== undefined) {
    if (typeof referrer_external_id !== 'string') {
      throw new BadRequestException(
        'create() options.referrer_external_id must be a string',
      );
    }
    validatedReferrerExternalId = validateE164PhoneNumber(
      referrer_external_id,
      'create() options.referrer_external_id',
    );
  }
  if (referrer_user_id !== undefined && typeof referrer_user_id !== 'string') {
    throw new BadRequestException(
      'create() options.referrer_user_id must be a string',
    );
  }
  if (referrer_external_id !== undefined && referrer_user_id !== undefined) {
    throw new BadRequestException(
      'create() requires at most one of referrer_external_id or referrer_user_id, not both',
    );
  }
  return {
    external_id: validatedExternalId,
    referrer_external_id: validatedReferrerExternalId,
    referrer_user_id,
  } as CreateUserOptions;
}
```

## Staff accounts (2026-09)

- `USER_ROLES = ['student','education_official','staff','dev','admin']` — users.role is plain text (the two-value CHECK was dropped in AddStaffFieldsToUsers); this list is the enforcement on every write (`validateUpdateUserOptions.new_role`, `PatchUserDto.role`). `STAFF_ROLES` = education_official, staff; `PROTECTED_ROLES` = dev, admin.
- `User` gains `geo_entity_id`, `role_title`, `avatar_seed`, `spotlight_message`, `staff_notes`, `deleted_at`.
- `UpdateUserOptions` gains `new_role`, `new_password_hash`, `new_geo_entity_id`, `new_role_title`, `new_staff_notes` (null clears), `deactivate`, `reactivate`; `PatchUserDto` mirrors the last five plus the widened `role`.
- `StaffCreateDto` (POST /users/staff-create body), `StaffUserRow` / `StaffUserDetail` / `StaffCreateResponse` (responses; `link` = dashboard-url.ts `staffDashboardLink`).
- `normaliseStaffPhone(raw)`: strip non-digits; 10 digits → `91` prefix; then the existing `validateE164PhoneNumber` (no second normaliser) — BadRequestException on failure; returns the stored form (no `+`).

## Public teacher dashboard (2026-09)

- `ProfilePatchDto` (PATCH /users/:id/profile): `name?`, `spotlight_message?`, `avatar_seed?`. `validateProfilePatch` strips HTML (`stripHtml`: tags removed, `&nbsp;` → space, whitespace collapsed), bounds name to 1–80, spotlight_message to ≤ 300 (empty → null), avatar_seed to `[A-Za-z0-9-]{1,64}`, and requires at least one field.
- `PublicProfile` — the forwardable GET /users/:id/public shape: `{id, name, role_title, avatar_seed, spotlight_message, geo_entity, ancestors, share_link}`. NEVER external_id, staff_notes or password_hash (user.controller.spec pins the allow-list with an inline snapshot).
- `UpdateUserOptions` gains `new_spotlight_message` (string | null) and `new_avatar_seed`.
