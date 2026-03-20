// pp-sketch/src/media-meta-data/media-meta-data.dto.prompt.md

import { BadRequestException } from '@nestjs/common';
import { User } from '../users/user.dto';

// --- Enums (enforced at service layer; stored as text in pg — no custom pg enum types) ---

export type MediaStatus = 'created' | 'queued' | 'ready' | 'failed';
export type MediaType = 'audio' | 'text' | 'video' | 'image';
export type MediaSource = 'whatsapp' | 'heygen' | 'azure' | 'sarvam' | 'reverie';

// --- Source → user rules ---
// 'whatsapp'  — user is REQUIRED  (user or user_external_id must be provided)
// 'heygen'    — user is FORBIDDEN (user and user_external_id must NOT be provided)
// Enforced structurally: each source has its own Options type and validator.

// --- Entity (matches pg media_metadata table) ---
// Note: for WhatsApp-sourced media, external_id is the mediaUrl that produced the media.

// media_type → field rules (enforced at service layer):
//   'text'                  — s3_key is NULL, text is REQUIRED
//   'audio' | 'video' | 'image' — s3_key is REQUIRED, text is NULL

export interface MediaMetaData {
  id: string;                              // UUID PK
  external_id: string;                     // unique — origin identifier (WhatsApp mediaUrl for WA media)
  s3_key?: string | null;                  // unique, object key in media-bucket; required unless media_type = 'text'
  text?: string | null;                    // the text content; required when media_type = 'text', null otherwise
  status: MediaStatus;
  media_type: MediaType;
  source: MediaSource;
  media_details?: Record<string, unknown>; // JSONB, e.g. { mime_type, byte_size }
  user_id?: string | null;                 // FK -> users.id, required for 'whatsapp', null for 'heygen'
  input_media_id?: string | null;          // FK -> media_metadata.id, "derived from" link. Many entities can point to one parent (one-to-many from parent's perspective). E.g. STT text transcripts → source audio, generated video → source image.
  generation_request_json?: Record<string, unknown> | null; // JSONB, request payload (no secrets)
  rolled_back: boolean;                    // default false. Set to true when outbound delivery fails (inflight-expired). Prevents future writes (scores, lesson state) from referencing this entity as user_message_id.
  created_at: Date;                        // TIMESTAMPTZ, default now()
}

// --- WhatsApp audio options ---
// source is always 'whatsapp', media_type is always 'audio'. User is required (exactly one of user or user_external_id).

export interface CreateWhatsappAudioMediaOptions {
  external_id: string;
  source_url: string;                      // where to fetch the media from (WhatsApp CDN URL); not stored — service downloads and uploads to S3
  user?: User;                             // trusted — service uses .id directly
  user_external_id?: string;               // untrusted — service calls user.service.ts/find()
  media_details?: Record<string, unknown>;
}

// --- Heygen options ---
// TODO: define when heygen integration is built

export interface CreateHeygenMediaOptions {
  // TODO
}

// --- FindTranscripts options ---
// Exactly one identifier must be provided to locate the parent media entity.

export interface FindTranscriptsOptions {
  media_metadata?: MediaMetaData;          // trusted — service uses .id directly
  media_metadata_id?: string;              // direct ID lookup
  media_metadata_external_id?: string;     // resolve via subquery on external_id
}

// --- FindMediaByStateTransitionId result ---
// One randomly selected entity per media type (or undefined if none exist for that type).

export interface FindMediaByStateTransitionIdResult {
  audio?: MediaMetaData;
  video?: MediaMetaData;
  text?: MediaMetaData;
  image?: MediaMetaData;
}

// --- Runtime validation ---

const VALID_MEDIA_STATUSES: MediaStatus[] = ['created', 'queued', 'ready', 'failed'];
const VALID_MEDIA_TYPES: MediaType[] = ['audio', 'text', 'video', 'image'];
const VALID_MEDIA_SOURCES: MediaSource[] = ['whatsapp', 'heygen'];

export function validateCreateWhatsappAudioMediaOptions(options: unknown): CreateWhatsappAudioMediaOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('createWhatsappAudioMedia() options must be an object');
  }
  const o = options as Record<string, unknown>;

  if (typeof o.external_id !== 'string' || o.external_id.length === 0) {
    throw new BadRequestException('createWhatsappAudioMedia() options.external_id is required and must be a non-empty string');
  }
  if (typeof o.source_url !== 'string' || o.source_url.length === 0) {
    throw new BadRequestException('createWhatsappAudioMedia() options.source_url is required and must be a non-empty string');
  }

  const hasUser = o.user !== undefined;
  const hasUserExternalId = o.user_external_id !== undefined;

  if (hasUser && hasUserExternalId) {
    throw new BadRequestException('createWhatsappAudioMedia() requires exactly one of user or user_external_id, not both');
  }
  if (!hasUser && !hasUserExternalId) {
    throw new BadRequestException('createWhatsappAudioMedia() requires exactly one of user or user_external_id');
  }

  if (hasUser && (typeof o.user !== 'object' || o.user === null || typeof (o.user as User).id !== 'string')) {
    throw new BadRequestException('createWhatsappAudioMedia() options.user must be a User object with a valid id');
  }
  if (hasUserExternalId && (typeof o.user_external_id !== 'string' || (o.user_external_id as string).length === 0)) {
    throw new BadRequestException('createWhatsappAudioMedia() options.user_external_id must be a non-empty string');
  }

  if (o.media_details !== undefined && (typeof o.media_details !== 'object' || o.media_details === null)) {
    throw new BadRequestException('createWhatsappAudioMedia() options.media_details must be an object');
  }

  return {
    external_id: o.external_id,
    source_url: o.source_url,
    user: o.user,
    user_external_id: o.user_external_id,
    media_details: o.media_details,
  } as CreateWhatsappAudioMediaOptions;
}

export function validateFindTranscriptsOptions(options: unknown): FindTranscriptsOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('findTranscripts() options must be an object');
  }
  const o = options as Record<string, unknown>;

  const hasEntity = o.media_metadata !== undefined;
  const hasId = o.media_metadata_id !== undefined;
  const hasExternalId = o.media_metadata_external_id !== undefined;
  const provided = [hasEntity, hasId, hasExternalId].filter(Boolean).length;

  if (provided !== 1) {
    throw new BadRequestException(
      'findTranscripts() requires exactly one of media_metadata, media_metadata_id, or media_metadata_external_id',
    );
  }

  if (hasEntity && (typeof o.media_metadata !== 'object' || o.media_metadata === null || typeof (o.media_metadata as MediaMetaData).id !== 'string')) {
    throw new BadRequestException('findTranscripts() options.media_metadata must be a MediaMetaData object with a valid id');
  }
  if (hasId && (typeof o.media_metadata_id !== 'string' || (o.media_metadata_id as string).length === 0)) {
    throw new BadRequestException('findTranscripts() options.media_metadata_id must be a non-empty string');
  }
  if (hasExternalId && (typeof o.media_metadata_external_id !== 'string' || (o.media_metadata_external_id as string).length === 0)) {
    throw new BadRequestException('findTranscripts() options.media_metadata_external_id must be a non-empty string');
  }

  return o as unknown as FindTranscriptsOptions;
}

export function validateCreateHeygenMediaOptions(options: unknown): CreateHeygenMediaOptions[] {
  // TODO: define when heygen integration is built
  return [] as CreateHeygenMediaOptions[];
}

// --- Service-layer enum guards (used by the service before any DB write/update) ---

export function assertValidMediaStatus(status: string): asserts status is MediaStatus {
  if (!VALID_MEDIA_STATUSES.includes(status as MediaStatus)) {
    throw new BadRequestException(`Invalid media status "${status}". Must be one of: ${VALID_MEDIA_STATUSES.join(', ')}`);
  }
}

export function assertValidMediaType(mediaType: string): asserts mediaType is MediaType {
  if (!VALID_MEDIA_TYPES.includes(mediaType as MediaType)) {
    throw new BadRequestException(`Invalid media type "${mediaType}". Must be one of: ${VALID_MEDIA_TYPES.join(', ')}`);
  }
}

export function assertValidMediaSource(source: string): asserts source is MediaSource {
  if (!VALID_MEDIA_SOURCES.includes(source as MediaSource)) {
    throw new BadRequestException(`Invalid media source "${source}". Must be one of: ${VALID_MEDIA_SOURCES.join(', ')}`);
  }
}
