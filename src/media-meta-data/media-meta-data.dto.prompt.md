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

// media_type → field rules (enforced at service layer):
//   'text'                  — s3_key is NULL, text is REQUIRED
//   'audio' | 'video' | 'image' — s3_key is REQUIRED, text is NULL

export interface MediaMetaData {
  id: string;                              // UUID PK
  wa_media_url?: string | null;            // UNIQUE WHERE NOT NULL — WhatsApp media reference. For WA-sourced audio: the inbound CDN URL (set at creation, used for dedup). For HeyGen audio/video: the WhatsApp media ID returned by the Cloud API upload (set by WHATSAPP_PRELOAD worker, refreshed every 20 days before the 30-day expiry).
  state_transition_id?: string | null;     // lookup key for lesson content — maps to stateTransitionId produced by the XState machine. No uniqueness constraint; multiple entities (one per media_type) share the same value. Indexed: (state_transition_id, status).
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
  wa_media_url: string;                    // WhatsApp CDN URL — stored on the entity (dedup via UNIQUE constraint) and used to download the media
  user?: User;                             // trusted — service uses .id directly
  user_external_id?: string;               // untrusted — service calls user.service.ts/find()
  media_details?: Record<string, unknown>;
}

// --- Heygen options ---
// source is always 'heygen'. User is FORBIDDEN (HeyGen media is not user-scoped).
// Accepts an array of items — each item becomes one media_metadata row + one BullMQ job.
// wa_media_url starts as NULL — set later by the WHATSAPP_PRELOAD worker after the media is uploaded to WhatsApp.
// The entity only transitions to status = 'ready' once wa_media_url is populated.

export interface CreateHeygenMediaItem {
  state_transition_id: string;             // required — the lesson state transition this media is for (e.g. 'कमल-word-initial')
  media_type: 'video' | 'audio';
  script_text: string;                     // the text the avatar speaks (video) or synthesizes (audio)

  // --- Optional overrides (fall back to env defaults HEYGEN_AVATAR_ID / HEYGEN_VOICE_ID) ---
  avatar_id?: string;                      // video only — override HEYGEN_AVATAR_ID
  avatar_style?: 'normal' | 'circle' | 'closeUp'; // video only — default 'normal'
  voice_id?: string;                       // override HEYGEN_VOICE_ID
  speed?: number;                          // voice speed multiplier
  emotion?: 'Excited' | 'Friendly' | 'Serious' | 'Soothing' | 'Broadcaster'; // video only
  locale?: string;                         // BCP-47 locale tag, e.g. 'en-IN', 'hi-IN'
  language?: string;                       // audio only — base language code, e.g. 'en', 'hi'

  // --- Video-specific options ---
  title?: string;                          // video title in HeyGen
  dimension?: { width: number; height: number }; // video resolution, default 1920×1080
  background?: {                           // video background
    type: 'color' | 'image' | 'video';
    value?: string;                        // hex color for 'color' type
    url?: string;                          // asset URL for 'image'/'video' type
    fit?: 'crop' | 'cover' | 'contain' | 'none';
  };
}

export interface CreateHeygenMediaOptions {
  items: CreateHeygenMediaItem[];
}

// --- FindTranscripts options ---
// Exactly one identifier must be provided to locate the parent media entity.

export interface FindTranscriptsOptions {
  media_metadata?: MediaMetaData;          // trusted — service uses .id directly
  media_metadata_id?: string;              // direct ID lookup
  media_metadata_wa_media_url?: string;    // resolve via subquery on wa_media_url
}

// --- FindMediaByStateTransitionId result ---
// One randomly selected entity per media type (or undefined if none exist for that type).

export interface FindMediaByStateTransitionIdResult {
  audio?: MediaMetaData;
  video?: MediaMetaData;
  text?: MediaMetaData;
  image?: MediaMetaData;
}

// --- WHATSAPP_PRELOAD job payload ---
// Used by the WHATSAPP_PRELOAD BullMQ worker (see whatsapp-preload.processor.prompt.md).
// Enqueued by: HeyGen outbound service (audio), HeyGen inbound processor (video).
// For reload jobs (20-day refresh cycle), the same shape is reused with reload = true.

export interface WhatsappPreloadJobDto {
  media_metadata_id: string;               // FK -> media_metadata.id — the entity whose wa_media_url will be set
  s3_key: string;                          // S3 object key — used to fetch the raw media bytes via media-bucket/outbound/getBuffer()
  reload?: boolean;                        // true when this is a periodic reload (skip status transition); falsy/absent for initial preload
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

  if (typeof o.wa_media_url !== 'string' || o.wa_media_url.length === 0) {
    throw new BadRequestException('createWhatsappAudioMedia() options.wa_media_url is required and must be a non-empty string');
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
    wa_media_url: o.wa_media_url,
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
  const hasWaMediaUrl = o.media_metadata_wa_media_url !== undefined;
  const provided = [hasEntity, hasId, hasWaMediaUrl].filter(Boolean).length;

  if (provided !== 1) {
    throw new BadRequestException(
      'findTranscripts() requires exactly one of media_metadata, media_metadata_id, or media_metadata_wa_media_url',
    );
  }

  if (hasEntity && (typeof o.media_metadata !== 'object' || o.media_metadata === null || typeof (o.media_metadata as MediaMetaData).id !== 'string')) {
    throw new BadRequestException('findTranscripts() options.media_metadata must be a MediaMetaData object with a valid id');
  }
  if (hasId && (typeof o.media_metadata_id !== 'string' || (o.media_metadata_id as string).length === 0)) {
    throw new BadRequestException('findTranscripts() options.media_metadata_id must be a non-empty string');
  }
  if (hasWaMediaUrl && (typeof o.media_metadata_wa_media_url !== 'string' || (o.media_metadata_wa_media_url as string).length === 0)) {
    throw new BadRequestException('findTranscripts() options.media_metadata_wa_media_url must be a non-empty string');
  }

  return o as unknown as FindTranscriptsOptions;
}

const VALID_HEYGEN_MEDIA_TYPES: Array<CreateHeygenMediaItem['media_type']> = ['video', 'audio'];
const VALID_AVATAR_STYLES: Array<NonNullable<CreateHeygenMediaItem['avatar_style']>> = ['normal', 'circle', 'closeUp'];
const VALID_EMOTIONS: Array<NonNullable<CreateHeygenMediaItem['emotion']>> = ['Excited', 'Friendly', 'Serious', 'Soothing', 'Broadcaster'];
const VALID_BG_TYPES: Array<'color' | 'image' | 'video'> = ['color', 'image', 'video'];
const VALID_BG_FITS: Array<'crop' | 'cover' | 'contain' | 'none'> = ['crop', 'cover', 'contain', 'none'];

export function validateCreateHeygenMediaOptions(options: unknown): CreateHeygenMediaOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('createHeygenMedia() options must be an object');
  }
  const o = options as Record<string, unknown>;

  if (!Array.isArray(o.items) || o.items.length === 0) {
    throw new BadRequestException('createHeygenMedia() options.items must be a non-empty array');
  }

  const validated: CreateHeygenMediaItem[] = o.items.map((raw: unknown, idx: number) => {
    if (!raw || typeof raw !== 'object') {
      throw new BadRequestException(`createHeygenMedia() items[${idx}] must be an object`);
    }
    const item = raw as Record<string, unknown>;

    if (typeof item.state_transition_id !== 'string' || item.state_transition_id.length === 0) {
      throw new BadRequestException(`createHeygenMedia() items[${idx}].state_transition_id is required and must be a non-empty string`);
    }
    if (typeof item.media_type !== 'string' || !VALID_HEYGEN_MEDIA_TYPES.includes(item.media_type as CreateHeygenMediaItem['media_type'])) {
      throw new BadRequestException(`createHeygenMedia() items[${idx}].media_type must be one of: ${VALID_HEYGEN_MEDIA_TYPES.join(', ')}`);
    }
    if (typeof item.script_text !== 'string' || item.script_text.length === 0) {
      throw new BadRequestException(`createHeygenMedia() items[${idx}].script_text is required and must be a non-empty string`);
    }
    if (item.script_text.length > 5000) {
      throw new BadRequestException(`createHeygenMedia() items[${idx}].script_text must be 5000 characters or fewer`);
    }

    // user must NOT be provided
    if (item.user !== undefined || item.user_id !== undefined || item.user_external_id !== undefined) {
      throw new BadRequestException(`createHeygenMedia() items[${idx}]: user/user_id/user_external_id are forbidden for heygen source`);
    }

    // optional string overrides
    if (item.avatar_id !== undefined && (typeof item.avatar_id !== 'string' || item.avatar_id.length === 0)) {
      throw new BadRequestException(`createHeygenMedia() items[${idx}].avatar_id must be a non-empty string`);
    }
    if (item.voice_id !== undefined && (typeof item.voice_id !== 'string' || item.voice_id.length === 0)) {
      throw new BadRequestException(`createHeygenMedia() items[${idx}].voice_id must be a non-empty string`);
    }
    if (item.avatar_style !== undefined && !VALID_AVATAR_STYLES.includes(item.avatar_style as NonNullable<CreateHeygenMediaItem['avatar_style']>)) {
      throw new BadRequestException(`createHeygenMedia() items[${idx}].avatar_style must be one of: ${VALID_AVATAR_STYLES.join(', ')}`);
    }
    if (item.emotion !== undefined && !VALID_EMOTIONS.includes(item.emotion as NonNullable<CreateHeygenMediaItem['emotion']>)) {
      throw new BadRequestException(`createHeygenMedia() items[${idx}].emotion must be one of: ${VALID_EMOTIONS.join(', ')}`);
    }
    if (item.speed !== undefined) {
      const maxSpeed = item.media_type === 'video' ? 1.5 : 2.0;
      if (typeof item.speed !== 'number' || item.speed < 0.5 || item.speed > maxSpeed) {
        throw new BadRequestException(`createHeygenMedia() items[${idx}].speed must be a number between 0.5 and ${maxSpeed}`);
      }
    }
    if (item.locale !== undefined && (typeof item.locale !== 'string' || item.locale.length === 0)) {
      throw new BadRequestException(`createHeygenMedia() items[${idx}].locale must be a non-empty string`);
    }
    if (item.language !== undefined && (typeof item.language !== 'string' || item.language.length === 0)) {
      throw new BadRequestException(`createHeygenMedia() items[${idx}].language must be a non-empty string`);
    }
    if (item.title !== undefined && typeof item.title !== 'string') {
      throw new BadRequestException(`createHeygenMedia() items[${idx}].title must be a string`);
    }

    // dimension
    if (item.dimension !== undefined) {
      if (typeof item.dimension !== 'object' || item.dimension === null) {
        throw new BadRequestException(`createHeygenMedia() items[${idx}].dimension must be an object`);
      }
      const dim = item.dimension as Record<string, unknown>;
      if (typeof dim.width !== 'number' || typeof dim.height !== 'number' || dim.width <= 0 || dim.height <= 0) {
        throw new BadRequestException(`createHeygenMedia() items[${idx}].dimension must have positive width and height`);
      }
    }

    // background
    if (item.background !== undefined) {
      if (typeof item.background !== 'object' || item.background === null) {
        throw new BadRequestException(`createHeygenMedia() items[${idx}].background must be an object`);
      }
      const bg = item.background as Record<string, unknown>;
      if (!VALID_BG_TYPES.includes(bg.type as 'color' | 'image' | 'video')) {
        throw new BadRequestException(`createHeygenMedia() items[${idx}].background.type must be one of: ${VALID_BG_TYPES.join(', ')}`);
      }
      if (bg.fit !== undefined && !VALID_BG_FITS.includes(bg.fit as 'crop' | 'cover' | 'contain' | 'none')) {
        throw new BadRequestException(`createHeygenMedia() items[${idx}].background.fit must be one of: ${VALID_BG_FITS.join(', ')}`);
      }
    }

    return {
      state_transition_id: item.state_transition_id,
      media_type: item.media_type,
      script_text: item.script_text,
      avatar_id: item.avatar_id,
      avatar_style: item.avatar_style,
      voice_id: item.voice_id,
      speed: item.speed,
      emotion: item.emotion,
      locale: item.locale,
      language: item.language,
      title: item.title,
      dimension: item.dimension,
      background: item.background,
    } as CreateHeygenMediaItem;
  });

  return { items: validated };
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
