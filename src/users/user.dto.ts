import { BadRequestException } from '@nestjs/common';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { validate as isUuid } from 'uuid';
import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsOptional,
  IsArray,
  ArrayMinSize,
  ValidateNested,
  IsISO8601,
  IsBoolean,
  IsUUID,
  Equals,
} from 'class-validator';
import type { GeoEntity } from '../geo-entities/geo-entity.dto';

export interface User {
  id: string;
  external_id: string;
  referrer_user_id: string | null;
  name: string | null;
  password_hash: string | null;
  role: string | null;
  // Parent onboarding (src/onboarding): all three written together when the
  // onboarding machine reaches `done`; null until then.
  birth_year: number | null;
  birth_month: number | null;
  recording_permissions_obtained_at: Date | null;
  // Staff accounts (education officials) — see staff-create below.
  geo_entity_id: string | null;
  role_title: string | null;
  avatar_seed: string | null;
  spotlight_message: string | null;
  staff_notes: string | null;
  // Soft delete for staff accounts. Gates login and the staff endpoints
  // only — never UserService.find() (the inbound processor's lookup).
  deleted_at: Date | null;
  created_at: Date;
}

// users.role is plain text (no CHECK since AddStaffFieldsToUsers); this list
// is the enforcement, applied on every write.
export const USER_ROLES = [
  'student',
  'education_official',
  'staff',
  'dev',
  'admin',
] as const;
export type UserRole = (typeof USER_ROLES)[number];
// Roles the staff endpoints (lookup, GET /users/:id, /onboarding) deal in.
export const STAFF_ROLES: readonly UserRole[] = ['education_official', 'staff'];
// Roles whose accounts the staff endpoints must never expose or edit.
export const PROTECTED_ROLES: readonly UserRole[] = ['dev', 'admin'];

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

export class PatchUserDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  name?: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  password?: string;

  @IsIn(USER_ROLES)
  @IsOptional()
  role?: UserRole;

  // Staff fields (education_official / staff targets only — 403 on dev/admin).
  @IsUUID()
  @IsOptional()
  new_geo_entity_id?: string;

  @IsString()
  @IsOptional()
  new_role_title?: string;

  @IsString()
  @IsOptional()
  new_staff_notes?: string;

  @IsBoolean()
  @Equals(true)
  @IsOptional()
  deactivate?: true;

  @IsBoolean()
  @Equals(true)
  @IsOptional()
  reactivate?: true;
}

// POST /users/staff-create body.
export class StaffCreateDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  external_id: string;

  @IsUUID()
  geo_entity_id: string;

  @IsString()
  @IsOptional()
  role_title?: string;

  @IsString()
  @IsOptional()
  staff_notes?: string;
}

// One staff account as the staff endpoints return it (lookup / GET :id /
// staff-create). `link` is the personal dashboard link (Prompt C's /d/:id).
export interface StaffUserRow {
  id: string;
  external_id: string;
  name: string | null;
  role: string;
  role_title: string | null;
  staff_notes: string | null;
  geo_entity_id: string | null;
  geo_entity_name: string | null;
  geo_entity_type: string | null;
  deleted_at: Date | null;
  link: string;
}

export interface StaffUserDetail extends StaffUserRow {
  geo_entity: GeoEntity | null;
  ancestors: GeoEntity[];
}

export interface StaffCreateResponse {
  user: StaffUserRow;
  link: string;
}

// Staff phone numbers arrive as whatever the operator typed: strip
// non-digits, treat a bare 10-digit Indian mobile as +91, then run the same
// E.164 validation every other external_id goes through. Returns the stored
// form (no '+').
export function normaliseStaffPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const withCountry = digits.length === 10 ? `91${digits}` : digits;
  if (withCountry.length === 0) {
    throw new BadRequestException('external_id must contain a phone number');
  }
  return validateE164PhoneNumber(withCountry, 'external_id');
}

// ─── Activity-time DTOs ───────────────────────────────────────────────────────

// One time window for activity-time queries. start <= end. Both ISO 8601.
export class TimeWindowDto {
  @IsISO8601()
  @IsNotEmpty()
  start: string;

  @IsISO8601()
  @IsNotEmpty()
  end: string;
}

// POST /users/activity-time body. users may be uuids or external_ids
// (E.164 phone numbers). windows may overlap.
export class ActivityTimeRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  users: string[];

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

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface ActivityDay {
  date: string;
  active_ms: number;
}

export interface DashboardReferrer {
  name: string | null;
  external_id: string;
}

export interface DashboardUserRow {
  id: string;
  name: string | null;
  external_id: string;
  referrer: DashboardReferrer | null;
  activity: ActivityDay[];
}

// GET /users/dashboard/summary — one row per IST day from the earliest record
// in the DB through today (today is a partial day). All-user aggregates:
//   users_over_5min — distinct users whose active_ms that IST day > 5 min
//   active_ms       — total active ms across all users that IST day
//   letters_learnt  — total (user, letter) pairs in the "learnt" bin as of the
//                     END of that day (a stock, not a flow — it can go down
//                     when a child regresses). Increments are day-over-day
//                     deltas, computed by the client.
// Activity uses the canonical UserActivityService gap rule; learnt uses the
// getLetterBins rule (last > seed AND n >= 4 AND min <= seed - 4).
export interface DashboardSummaryDay {
  date: string; // IST YYYY-MM-DD
  users_over_5min: number;
  active_ms: number;
  letters_learnt: number;
}

export interface DashboardSummaryResponse {
  daily: DashboardSummaryDay[];
}

// GET /users/:id/metrics — headline numbers for the user page. All computed at
// read time (no stored columns): days_since_signup from users.created_at;
// active-minute figures from the canonical UserActivityService logic, bucketed
// by IST day.
export interface UserMetrics {
  days_since_signup: number;
  total_active_ms: number;
  days_over_five_min: number;
}

export interface TranscriptRow {
  text: string | null;
  source: string;
  created_at: Date;
}

export interface ScoreChangeRow {
  grapheme: string;
  score: number;
  prev_score: number | null;
}

export interface MediaRow {
  id: string;
  created_at: Date;
  has_audio: boolean;
  transcripts: TranscriptRow[];
  word: string | null;
  starting_state: string | null;
  answer: string | null;
  answer_correct: boolean | null;
  score_changes: ScoreChangeRow[];
  final_state: string | null;
  // Reading speed of a passage-read recording (words / container-parsed
  // duration); null for word/drill turns and rows without duration_ms.
  wpm: number | null;
}

export interface UserInfoRow {
  name: string | null;
  phone: string;
}

export interface UserMediaResponse {
  user: UserInfoRow;
  media: MediaRow[];
}

export interface ScoreRow {
  score: number;
  created_at: Date;
  letter_id: string;
  grapheme: string;
  is_seed: boolean;
  user_message_id: string | null;
}

export interface LoginResponse {
  id: string;
  external_id: string;
  role: string;
}

export interface UserResponse {
  id: string;
  external_id: string;
  name: string | null;
  role: string | null;
}

export interface DeleteResponse {
  deleted: true;
}

// ─── Internal DTOs ────────────────────────────────────────────────────────────

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
  new_role?: UserRole;
  new_password_hash?: string;
  // Staff fields; null clears. deactivate/reactivate set/clear deleted_at.
  new_geo_entity_id?: string | null;
  new_role_title?: string | null;
  new_staff_notes?: string | null;
  deactivate?: boolean;
  reactivate?: boolean;
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

export interface CreateStaffOptions {
  name: string;
  // Already normalised (normaliseStaffPhone).
  external_id: string;
  geo_entity_id: string;
  role_title: string;
  staff_notes?: string | null;
}

// Splits a list of user identifiers into uuids and normalized E.164 external
// ids. Throws one BadRequestException listing every item that is neither a
// valid uuid nor a valid E.164 phone. `canonical` mirrors `inputs` in order,
// each item replaced with its canonical form (uuid or normalized E.164) —
// useful for callers that align DB lookups back to input positions. Does no
// I/O.
export function partitionUserIdentifiers(inputs: string[]): {
  ids: string[];
  externalIds: string[];
  canonical: string[];
} {
  const ids: string[] = [];
  const externalIds: string[] = [];
  const canonical: string[] = [];
  const bad: string[] = [];
  for (const raw of inputs) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      bad.push('<empty>');
      canonical.push(trimmed);
      continue;
    }
    if (isUuid(trimmed)) {
      ids.push(trimmed);
      canonical.push(trimmed);
      continue;
    }
    try {
      const normalized = validateE164PhoneNumber(trimmed, 'identifier');
      externalIds.push(normalized);
      canonical.push(normalized);
    } catch {
      bad.push(trimmed);
      canonical.push(trimmed);
    }
  }
  if (bad.length > 0) {
    throw new BadRequestException(
      `invalid identifiers (not a uuid or E.164 phone): ${bad.join(', ')}`,
    );
  }
  return { ids, externalIds, canonical };
}

export function validateE164PhoneNumber(
  value: string,
  fieldName: string,
): string {
  const normalized = value.startsWith('+') ? value : `+${value}`;
  const parsed = parsePhoneNumberFromString(normalized);
  if (!parsed || !parsed.isValid()) {
    throw new BadRequestException(
      `${fieldName} must be a valid phone number in WhatsApp format (e.g. 923001234567)`,
    );
  }
  return parsed.format('E.164').replace(/^\+/, '');
}

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
    new_name,
    new_referrer_user_id,
    new_referrer_external_id,
    new_birth_year,
    new_birth_month,
    new_recording_permissions_obtained_at,
    new_role,
    new_password_hash,
    new_geo_entity_id,
    new_role_title,
    new_staff_notes,
    deactivate,
    reactivate,
  } = options as Record<string, unknown>;
  if (id !== undefined && typeof id !== 'string') {
    throw new BadRequestException('update() options.id must be a string');
  }
  if (
    new_role !== undefined &&
    !(USER_ROLES as readonly unknown[]).includes(new_role)
  ) {
    throw new BadRequestException(
      `update() options.new_role must be one of ${USER_ROLES.join(', ')}`,
    );
  }
  if (
    new_password_hash !== undefined &&
    typeof new_password_hash !== 'string'
  ) {
    throw new BadRequestException(
      'update() options.new_password_hash must be a string',
    );
  }
  if (
    new_geo_entity_id !== undefined &&
    new_geo_entity_id !== null &&
    (typeof new_geo_entity_id !== 'string' || !isUuid(new_geo_entity_id))
  ) {
    throw new BadRequestException(
      'update() options.new_geo_entity_id must be a uuid or null',
    );
  }
  for (const [key, value] of [
    ['new_role_title', new_role_title],
    ['new_staff_notes', new_staff_notes],
  ] as const) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new BadRequestException(
        `update() options.${key} must be a string or null`,
      );
    }
  }
  for (const [key, value] of [
    ['deactivate', deactivate],
    ['reactivate', reactivate],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new BadRequestException(
        `update() options.${key} must be a boolean`,
      );
    }
  }
  if (deactivate === true && reactivate === true) {
    throw new BadRequestException(
      'update() requires at most one of deactivate or reactivate',
    );
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
  if (new_name !== undefined && typeof new_name !== 'string') {
    throw new BadRequestException('update() options.new_name must be a string');
  }
  if (
    new_birth_year !== undefined &&
    new_birth_year !== null &&
    !Number.isInteger(new_birth_year)
  ) {
    throw new BadRequestException(
      'update() options.new_birth_year must be an integer or null',
    );
  }
  if (
    new_birth_month !== undefined &&
    new_birth_month !== null &&
    (!Number.isInteger(new_birth_month) ||
      (new_birth_month as number) < 1 ||
      (new_birth_month as number) > 12)
  ) {
    throw new BadRequestException(
      'update() options.new_birth_month must be an integer 1–12 or null',
    );
  }
  if (
    new_recording_permissions_obtained_at !== undefined &&
    new_recording_permissions_obtained_at !== null &&
    !(
      new_recording_permissions_obtained_at instanceof Date &&
      !Number.isNaN(new_recording_permissions_obtained_at.getTime())
    )
  ) {
    throw new BadRequestException(
      'update() options.new_recording_permissions_obtained_at must be a Date or null',
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
    new_referrer_external_id === undefined &&
    new_birth_year === undefined &&
    new_birth_month === undefined &&
    new_recording_permissions_obtained_at === undefined &&
    new_role === undefined &&
    new_password_hash === undefined &&
    new_geo_entity_id === undefined &&
    new_role_title === undefined &&
    new_staff_notes === undefined &&
    deactivate !== true &&
    reactivate !== true
  ) {
    throw new BadRequestException(
      'update() requires at least one field to update (new_external_id, new_name, new_referrer_user_id, new_referrer_external_id, new_birth_year, new_birth_month, new_recording_permissions_obtained_at, new_role, new_password_hash, new_geo_entity_id, new_role_title, new_staff_notes, deactivate, reactivate)',
    );
  }
  return {
    id,
    external_id: validatedExternalId,
    new_external_id: validatedNewExternalId,
    new_name,
    new_referrer_user_id,
    new_referrer_external_id: validatedNewReferrerExternalId,
    new_birth_year,
    new_birth_month,
    new_recording_permissions_obtained_at,
    new_role,
    new_password_hash,
    new_geo_entity_id,
    new_role_title,
    new_staff_notes,
    deactivate: deactivate === true ? true : undefined,
    reactivate: reactivate === true ? true : undefined,
  } as UpdateUserOptions;
}

export function validateCreateUserOptions(options: unknown): CreateUserOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('create() options must be an object');
  }
  const { external_id, name, referrer_external_id, referrer_user_id } =
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
  if (name !== undefined && typeof name !== 'string') {
    throw new BadRequestException('create() options.name must be a string');
  }
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
    name,
    referrer_external_id: validatedReferrerExternalId,
    referrer_user_id,
  } as CreateUserOptions;
}

// ─── Literacy proxy test scores (2026-07, reworked 2026-08) ──────────────────

export interface TestSnapshotPoint {
  at: Date;
  score: number;
  passed: boolean;
}

// Snapshot-based score for NIPUN grade 2/3 and MPL-B: only a student's FIRST
// attempt at each question counts (after seeing the explanation, later
// attempts are invalidated for testing). history replays the full snapshot
// algorithm over each chronological prefix of deduped first attempts
// (prefixes with insufficient data are skipped); latest equals the final
// history entry.
export interface SnapshotTestScore {
  status: 'ok' | 'insufficient_data';
  attempts_available: number;
  latest?: TestSnapshotPoint;
  history?: TestSnapshotPoint[];
}

export interface LiteracyTestScores {
  // Grade 2: most recent 4 first attempts at level-10 R1.1/R1.2/R1.3
  // questions; pass at score > 0.5.
  nipun_grade_2: SnapshotTestScore;
  // Grade 3: most recent 4 first attempts at level-11/12 R1.1/R1.2/R1.3
  // questions; pass at score > 0.5.
  nipun_grade_3: SnapshotTestScore;
  // MPL-B: 20 level-11/12 first attempts selected by the four-filter
  // algorithm in UserService.getLiteracyTestScores; pass at score > 0.5.
  mpl_b: SnapshotTestScore;
}
