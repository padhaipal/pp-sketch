import { BadRequestException } from '@nestjs/common';
import type { OtelCarrier } from '../otel/otel.dto';
import { User } from '../users/user.dto';

const VALID_MEDIA_STATUSES = ['created', 'queued', 'ready', 'failed'] as const;
export type MediaStatus = (typeof VALID_MEDIA_STATUSES)[number];

const VALID_MEDIA_TYPES = [
  'audio',
  'text',
  'video',
  'image',
  'sticker',
] as const;
export type MediaType = (typeof VALID_MEDIA_TYPES)[number];

const VALID_MEDIA_SOURCES = [
  'whatsapp',
  'heygen',
  'elevenlabs',
  'azure',
  'sarvam',
  'reverie',
  'dashboard',
] as const;
export type MediaSource = (typeof VALID_MEDIA_SOURCES)[number];

export interface MediaMetaData {
  id: string;
  wa_media_url?: string | null;
  state_transition_id?: string | null;
  s3_key?: string | null;
  content_hash?: string | null;
  text?: string | null;
  status: MediaStatus;
  media_type: MediaType;
  source: MediaSource;
  media_details?: Record<string, unknown> | null;
  user_id?: string | null;
  input_media_id?: string | null;
  generation_request_json?: Record<string, unknown> | null;
  rolled_back: boolean;
  created_at: Date;
}

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface DashboardTranscriptResponse {
  id: string;
  text: string | null;
  source: string;
  input_media_id: string | null;
  user_id: string | null;
  created_at: Date;
}

export interface DeleteResponse {
  deleted: true;
}

// ─── Internal DTOs ────────────────────────────────────────────────────────────

export interface CreateWhatsappAudioMediaOptions {
  wa_media_url: string;
  user?: User;
  user_external_id?: string;
  media_details?: Record<string, unknown>;
  otel_carrier: OtelCarrier;
}

export interface CreateTextMediaOptions {
  text: string;
  user?: User;
  user_external_id?: string;
  source?: MediaSource;
  input_media_id?: string;
  media_details?: Record<string, unknown>;
}

export interface CreateHeygenMediaItem {
  state_transition_id: string;
  media_type: 'video' | 'audio';
  script_text: string;
  avatar_id?: string;
  avatar_style?: 'normal' | 'circle' | 'closeUp';
  voice_id?: string;
  speed?: number;
  emotion?: 'Excited' | 'Friendly' | 'Serious' | 'Soothing' | 'Broadcaster';
  locale?: string;
  language?: string;
  title?: string;
  dimension?: { width: number; height: number };
  background?: {
    type: 'color' | 'image' | 'video';
    value?: string;
    url?: string;
    fit?: 'crop' | 'cover' | 'contain' | 'none';
  };
}

export interface CreateHeygenMediaOptions {
  items: CreateHeygenMediaItem[];
}

export interface CreateElevenlabsMediaItem {
  state_transition_id: string;
  script_text: string;
  voice_id?: string;
  model_id?: string;
  language_code?: string;
  voice_settings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    speed?: number;
    use_speaker_boost?: boolean;
  };
}

export interface CreateElevenlabsMediaOptions {
  items: CreateElevenlabsMediaItem[];
}

// Audio is restricted to OGG/Opus so WhatsApp renders it as a voice-note (PTT) bubble.
const VALID_STATIC_MEDIA_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'audio/ogg',
] as const;
type StaticMediaMimeType = (typeof VALID_STATIC_MEDIA_MIME_TYPES)[number];

const MIME_TO_MEDIA_TYPE: Record<StaticMediaMimeType, MediaType> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'sticker',
  'video/mp4': 'video',
  'audio/ogg': 'audio',
};

const STATIC_MEDIA_MAX_BYTES: Record<
  'image' | 'video' | 'audio' | 'sticker',
  number
> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  sticker: 500 * 1024,
};

// WhatsApp sticker limits (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media)
const WEBP_STATIC_MAX_BYTES = 100 * 1024;
const WEBP_ANIMATED_MAX_BYTES = 500 * 1024;
const WEBP_REQUIRED_DIMENSION = 512;

interface WebpInfo {
  width: number;
  height: number;
  animated: boolean;
}

// Parses width/height/animation flag from a WebP buffer header.
// Supports VP8 (lossy), VP8L (lossless), and VP8X (extended) chunks.
function parseWebpHeader(buf: Buffer): WebpInfo {
  if (
    buf.length < 30 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new BadRequestException('invalid webp: missing RIFF/WEBP header');
  }
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const flags = buf[20];
    const animated = (flags & 0x02) !== 0;
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height, animated };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) {
      throw new BadRequestException('invalid webp: bad VP8L signature');
    }
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height, animated: false };
  }
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) {
      throw new BadRequestException('invalid webp: bad VP8 start code');
    }
    const width = (buf[26] | (buf[27] << 8)) & 0x3fff;
    const height = (buf[28] | (buf[29] << 8)) & 0x3fff;
    return { width, height, animated: false };
  }
  throw new BadRequestException(`invalid webp: unknown chunk "${chunk}"`);
}

const STATIC_TEXT_MAX_CHARS = 4096;

export interface UploadStaticMediaItem {
  state_transition_id: string;
  media_type: MediaType;
  text?: string;
}

export type UploadStaticMediaItemStatus =
  | 'created'
  | 'duplicate_skipped'
  | 'failed';

export interface UploadStaticMediaItemResult {
  index: number;
  status: UploadStaticMediaItemStatus;
  entity?: MediaMetaData;
  error?: string;
}

export interface UploadStaticMediaResult {
  results: UploadStaticMediaItemResult[];
  summary: { created: number; duplicate_skipped: number; failed: number };
}

export interface FindTranscriptsOptions {
  media_metadata?: MediaMetaData;
  media_metadata_id?: string;
  media_metadata_wa_media_url?: string;
}

export interface FindMediaByStateTransitionIdResult {
  audio?: MediaMetaData;
  video?: MediaMetaData;
  text?: MediaMetaData;
  image?: MediaMetaData;
  sticker?: MediaMetaData;
}

export interface WhatsappPreloadJobDto {
  media_metadata_id: string;
  s3_key: string;
  reload?: boolean;
  otel_carrier: OtelCarrier;
}

// --- Runtime validation ---

export function validateCreateWhatsappAudioMediaOptions(
  options: unknown,
): CreateWhatsappAudioMediaOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException(
      'createWhatsappAudioMedia() options must be an object',
    );
  }
  const o = options as Record<string, unknown>;

  if (typeof o.wa_media_url !== 'string' || o.wa_media_url.length === 0) {
    throw new BadRequestException(
      'createWhatsappAudioMedia() options.wa_media_url is required and must be a non-empty string',
    );
  }

  const hasUser = o.user !== undefined;
  const hasUserExternalId = o.user_external_id !== undefined;

  if (hasUser && hasUserExternalId) {
    throw new BadRequestException(
      'createWhatsappAudioMedia() requires exactly one of user or user_external_id, not both',
    );
  }
  if (!hasUser && !hasUserExternalId) {
    throw new BadRequestException(
      'createWhatsappAudioMedia() requires exactly one of user or user_external_id',
    );
  }

  if (
    hasUser &&
    (typeof o.user !== 'object' ||
      o.user === null ||
      typeof (o.user as User).id !== 'string')
  ) {
    throw new BadRequestException(
      'createWhatsappAudioMedia() options.user must be a User object with a valid id',
    );
  }
  if (
    hasUserExternalId &&
    (typeof o.user_external_id !== 'string' || o.user_external_id.length === 0)
  ) {
    throw new BadRequestException(
      'createWhatsappAudioMedia() options.user_external_id must be a non-empty string',
    );
  }

  if (
    o.media_details !== undefined &&
    (typeof o.media_details !== 'object' || o.media_details === null)
  ) {
    throw new BadRequestException(
      'createWhatsappAudioMedia() options.media_details must be an object',
    );
  }

  if (
    o.otel_carrier === null ||
    typeof o.otel_carrier !== 'object' ||
    Array.isArray(o.otel_carrier) ||
    Object.keys(o.otel_carrier as Record<string, unknown>).length === 0 ||
    !Object.values(o.otel_carrier as Record<string, unknown>).every(
      (v) => typeof v === 'string',
    )
  ) {
    throw new BadRequestException(
      'createWhatsappAudioMedia() options.otel_carrier must be a non-empty Record<string, string>',
    );
  }

  return {
    wa_media_url: o.wa_media_url,
    user: o.user,
    user_external_id: o.user_external_id,
    media_details: o.media_details,
    otel_carrier: o.otel_carrier,
  } as CreateWhatsappAudioMediaOptions;
}

export function validateCreateTextMediaOptions(
  options: unknown,
): CreateTextMediaOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException(
      'createTextMedia() options must be an object',
    );
  }
  const o = options as Record<string, unknown>;

  if (typeof o.text !== 'string' || o.text.length === 0) {
    throw new BadRequestException(
      'createTextMedia() options.text is required and must be a non-empty string',
    );
  }

  const hasUser = o.user !== undefined;
  const hasUserExternalId = o.user_external_id !== undefined;

  if (hasUser && hasUserExternalId) {
    throw new BadRequestException(
      'createTextMedia() requires exactly one of user or user_external_id, not both',
    );
  }
  if (!hasUser && !hasUserExternalId) {
    throw new BadRequestException(
      'createTextMedia() requires exactly one of user or user_external_id',
    );
  }

  if (
    hasUser &&
    (typeof o.user !== 'object' ||
      o.user === null ||
      typeof (o.user as User).id !== 'string')
  ) {
    throw new BadRequestException(
      'createTextMedia() options.user must be a User object with a valid id',
    );
  }
  if (
    hasUserExternalId &&
    (typeof o.user_external_id !== 'string' || o.user_external_id.length === 0)
  ) {
    throw new BadRequestException(
      'createTextMedia() options.user_external_id must be a non-empty string',
    );
  }

  if (o.source !== undefined) {
    assertValidMediaSource(o.source as string);
  }

  if (
    o.input_media_id !== undefined &&
    (typeof o.input_media_id !== 'string' || o.input_media_id.length === 0)
  ) {
    throw new BadRequestException(
      'createTextMedia() options.input_media_id must be a non-empty string',
    );
  }

  if (
    o.media_details !== undefined &&
    (typeof o.media_details !== 'object' || o.media_details === null)
  ) {
    throw new BadRequestException(
      'createTextMedia() options.media_details must be an object',
    );
  }

  return {
    text: o.text,
    user: o.user,
    user_external_id: o.user_external_id,
    source: o.source,
    input_media_id: o.input_media_id,
    media_details: o.media_details,
  } as CreateTextMediaOptions;
}

export function validateFindTranscriptsOptions(
  options: unknown,
): FindTranscriptsOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException(
      'findTranscripts() options must be an object',
    );
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

  if (
    hasEntity &&
    (typeof o.media_metadata !== 'object' ||
      o.media_metadata === null ||
      typeof (o.media_metadata as MediaMetaData).id !== 'string')
  ) {
    throw new BadRequestException(
      'findTranscripts() options.media_metadata must be a MediaMetaData object with a valid id',
    );
  }
  if (
    hasId &&
    (typeof o.media_metadata_id !== 'string' ||
      o.media_metadata_id.length === 0)
  ) {
    throw new BadRequestException(
      'findTranscripts() options.media_metadata_id must be a non-empty string',
    );
  }
  if (
    hasWaMediaUrl &&
    (typeof o.media_metadata_wa_media_url !== 'string' ||
      o.media_metadata_wa_media_url.length === 0)
  ) {
    throw new BadRequestException(
      'findTranscripts() options.media_metadata_wa_media_url must be a non-empty string',
    );
  }

  return o as unknown as FindTranscriptsOptions;
}

const VALID_HEYGEN_MEDIA_TYPES: Array<CreateHeygenMediaItem['media_type']> = [
  'video',
  'audio',
];
const VALID_AVATAR_STYLES: Array<
  NonNullable<CreateHeygenMediaItem['avatar_style']>
> = ['normal', 'circle', 'closeUp'];
const VALID_EMOTIONS: Array<NonNullable<CreateHeygenMediaItem['emotion']>> = [
  'Excited',
  'Friendly',
  'Serious',
  'Soothing',
  'Broadcaster',
];
const VALID_BG_TYPES: Array<'color' | 'image' | 'video'> = [
  'color',
  'image',
  'video',
];
const VALID_BG_FITS: Array<'crop' | 'cover' | 'contain' | 'none'> = [
  'crop',
  'cover',
  'contain',
  'none',
];

export function validateCreateHeygenMediaOptions(
  options: unknown,
): CreateHeygenMediaOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException(
      'createHeygenMedia() options must be an object',
    );
  }
  const o = options as Record<string, unknown>;

  if (!Array.isArray(o.items) || o.items.length === 0) {
    throw new BadRequestException(
      'createHeygenMedia() options.items must be a non-empty array',
    );
  }

  const validated: CreateHeygenMediaItem[] = o.items.map(
    (raw: unknown, idx: number) => {
      if (!raw || typeof raw !== 'object') {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}] must be an object`,
        );
      }
      const item = raw as Record<string, unknown>;

      if (
        typeof item.state_transition_id !== 'string' ||
        item.state_transition_id.length === 0
      ) {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}].state_transition_id is required and must be a non-empty string`,
        );
      }
      if (
        typeof item.media_type !== 'string' ||
        !VALID_HEYGEN_MEDIA_TYPES.includes(
          item.media_type as CreateHeygenMediaItem['media_type'],
        )
      ) {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}].media_type must be one of: ${VALID_HEYGEN_MEDIA_TYPES.join(', ')}`,
        );
      }
      if (
        typeof item.script_text !== 'string' ||
        item.script_text.length === 0
      ) {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}].script_text is required and must be a non-empty string`,
        );
      }
      if (item.script_text.length > 5000) {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}].script_text must be 5000 characters or fewer`,
        );
      }

      if (
        item.user !== undefined ||
        item.user_id !== undefined ||
        item.user_external_id !== undefined
      ) {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}]: user/user_id/user_external_id are forbidden for heygen source`,
        );
      }

      if (
        item.avatar_id !== undefined &&
        (typeof item.avatar_id !== 'string' || item.avatar_id.length === 0)
      ) {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}].avatar_id must be a non-empty string`,
        );
      }
      if (
        item.voice_id !== undefined &&
        (typeof item.voice_id !== 'string' || item.voice_id.length === 0)
      ) {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}].voice_id must be a non-empty string`,
        );
      }
      if (
        item.avatar_style !== undefined &&
        !VALID_AVATAR_STYLES.includes(
          item.avatar_style as NonNullable<
            CreateHeygenMediaItem['avatar_style']
          >,
        )
      ) {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}].avatar_style must be one of: ${VALID_AVATAR_STYLES.join(', ')}`,
        );
      }
      if (
        item.emotion !== undefined &&
        !VALID_EMOTIONS.includes(
          item.emotion as NonNullable<CreateHeygenMediaItem['emotion']>,
        )
      ) {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}].emotion must be one of: ${VALID_EMOTIONS.join(', ')}`,
        );
      }
      if (item.speed !== undefined) {
        const maxSpeed = item.media_type === 'video' ? 1.5 : 2.0;
        if (
          typeof item.speed !== 'number' ||
          item.speed < 0.5 ||
          item.speed > maxSpeed
        ) {
          throw new BadRequestException(
            `createHeygenMedia() items[${idx}].speed must be a number between 0.5 and ${maxSpeed}`,
          );
        }
      }
      if (
        item.locale !== undefined &&
        (typeof item.locale !== 'string' || item.locale.length === 0)
      ) {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}].locale must be a non-empty string`,
        );
      }
      if (
        item.language !== undefined &&
        (typeof item.language !== 'string' || item.language.length === 0)
      ) {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}].language must be a non-empty string`,
        );
      }
      if (item.title !== undefined && typeof item.title !== 'string') {
        throw new BadRequestException(
          `createHeygenMedia() items[${idx}].title must be a string`,
        );
      }

      if (item.dimension !== undefined) {
        if (typeof item.dimension !== 'object' || item.dimension === null) {
          throw new BadRequestException(
            `createHeygenMedia() items[${idx}].dimension must be an object`,
          );
        }
        const dim = item.dimension as Record<string, unknown>;
        if (
          typeof dim.width !== 'number' ||
          typeof dim.height !== 'number' ||
          dim.width <= 0 ||
          dim.height <= 0
        ) {
          throw new BadRequestException(
            `createHeygenMedia() items[${idx}].dimension must have positive width and height`,
          );
        }
      }

      if (item.background !== undefined) {
        if (typeof item.background !== 'object' || item.background === null) {
          throw new BadRequestException(
            `createHeygenMedia() items[${idx}].background must be an object`,
          );
        }
        const bg = item.background as Record<string, unknown>;
        if (!VALID_BG_TYPES.includes(bg.type as 'color' | 'image' | 'video')) {
          throw new BadRequestException(
            `createHeygenMedia() items[${idx}].background.type must be one of: ${VALID_BG_TYPES.join(', ')}`,
          );
        }
        if (
          bg.fit !== undefined &&
          !VALID_BG_FITS.includes(
            bg.fit as 'crop' | 'cover' | 'contain' | 'none',
          )
        ) {
          throw new BadRequestException(
            `createHeygenMedia() items[${idx}].background.fit must be one of: ${VALID_BG_FITS.join(', ')}`,
          );
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
    },
  );

  return { items: validated };
}

export function validateUploadStaticMediaItems(
  rawItems: unknown,
): UploadStaticMediaItem[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new BadRequestException(
      'uploadStaticMedia() items must be a non-empty array',
    );
  }
  return rawItems.map((raw: unknown, idx: number) => {
    if (!raw || typeof raw !== 'object') {
      throw new BadRequestException(
        `uploadStaticMedia() items[${idx}] must be an object`,
      );
    }
    const item = raw as Record<string, unknown>;
    if (
      typeof item.state_transition_id !== 'string' ||
      item.state_transition_id.length === 0
    ) {
      throw new BadRequestException(
        `uploadStaticMedia() items[${idx}].state_transition_id is required and must be a non-empty string`,
      );
    }
    if (
      typeof item.media_type !== 'string' ||
      !VALID_MEDIA_TYPES.includes(item.media_type as MediaType)
    ) {
      throw new BadRequestException(
        `uploadStaticMedia() items[${idx}].media_type is required and must be one of: ${VALID_MEDIA_TYPES.join(', ')}`,
      );
    }
    const media_type = item.media_type as MediaType;
    if (media_type === 'text') {
      if (typeof item.text !== 'string' || item.text.length === 0) {
        throw new BadRequestException(
          `uploadStaticMedia() items[${idx}].text is required and must be a non-empty string when media_type === 'text'`,
        );
      }
      if (item.text.length > STATIC_TEXT_MAX_CHARS) {
        throw new BadRequestException(
          `uploadStaticMedia() items[${idx}].text length ${item.text.length} exceeds ${STATIC_TEXT_MAX_CHARS} char limit`,
        );
      }
      return {
        state_transition_id: item.state_transition_id,
        media_type,
        text: item.text,
      };
    }
    if (item.text !== undefined) {
      throw new BadRequestException(
        `uploadStaticMedia() items[${idx}].text is forbidden when media_type !== 'text'`,
      );
    }
    return { state_transition_id: item.state_transition_id, media_type };
  });
}

export function assertValidStaticMediaFile(
  file: { mimetype: string; size: number; buffer: Buffer },
  idx: number,
): { media_type: MediaType; mime_type: StaticMediaMimeType } {
  if (
    !VALID_STATIC_MEDIA_MIME_TYPES.includes(
      file.mimetype as StaticMediaMimeType,
    )
  ) {
    throw new BadRequestException(
      `uploadStaticMedia() files[${idx}]: unsupported MIME type "${file.mimetype}". Must be one of: ${VALID_STATIC_MEDIA_MIME_TYPES.join(', ')}`,
    );
  }
  const mime = file.mimetype as StaticMediaMimeType;
  const media_type = MIME_TO_MEDIA_TYPE[mime];

  // webp gets sticker-specific validation (dimensions + size by static/animated).
  if (mime === 'image/webp') {
    let info: WebpInfo;
    try {
      info = parseWebpHeader(file.buffer);
    } catch (err) {
      throw new BadRequestException(
        `uploadStaticMedia() files[${idx}]: ${(err as Error).message}`,
      );
    }
    if (
      info.width !== WEBP_REQUIRED_DIMENSION ||
      info.height !== WEBP_REQUIRED_DIMENSION
    ) {
      throw new BadRequestException(
        `uploadStaticMedia() files[${idx}]: webp must be ${WEBP_REQUIRED_DIMENSION}x${WEBP_REQUIRED_DIMENSION}, got ${info.width}x${info.height}`,
      );
    }
    const webpMax = info.animated
      ? WEBP_ANIMATED_MAX_BYTES
      : WEBP_STATIC_MAX_BYTES;
    if (file.size > webpMax) {
      throw new BadRequestException(
        `uploadStaticMedia() files[${idx}]: ${info.animated ? 'animated' : 'static'} webp size ${file.size} bytes exceeds ${webpMax} byte limit`,
      );
    }
    return { media_type, mime_type: mime };
  }

  const maxBytes =
    STATIC_MEDIA_MAX_BYTES[
      media_type as 'image' | 'video' | 'audio' | 'sticker'
    ];
  if (file.size > maxBytes) {
    throw new BadRequestException(
      `uploadStaticMedia() files[${idx}]: file size ${file.size} bytes exceeds ${maxBytes} byte limit for ${media_type}`,
    );
  }
  return { media_type, mime_type: mime };
}

export function validateCreateElevenlabsMediaOptions(
  options: unknown,
): CreateElevenlabsMediaOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException(
      'createElevenlabsMedia() options must be an object',
    );
  }
  const o = options as Record<string, unknown>;

  if (!Array.isArray(o.items) || o.items.length === 0) {
    throw new BadRequestException(
      'createElevenlabsMedia() options.items must be a non-empty array',
    );
  }

  const validated: CreateElevenlabsMediaItem[] = o.items.map(
    (raw: unknown, idx: number) => {
      if (!raw || typeof raw !== 'object') {
        throw new BadRequestException(
          `createElevenlabsMedia() items[${idx}] must be an object`,
        );
      }
      const item = raw as Record<string, unknown>;

      if (
        typeof item.state_transition_id !== 'string' ||
        item.state_transition_id.length === 0
      ) {
        throw new BadRequestException(
          `createElevenlabsMedia() items[${idx}].state_transition_id is required and must be a non-empty string`,
        );
      }
      if (
        typeof item.script_text !== 'string' ||
        item.script_text.length === 0
      ) {
        throw new BadRequestException(
          `createElevenlabsMedia() items[${idx}].script_text is required and must be a non-empty string`,
        );
      }
      if (item.script_text.length > 5000) {
        throw new BadRequestException(
          `createElevenlabsMedia() items[${idx}].script_text must be 5000 characters or fewer`,
        );
      }

      if (
        item.user !== undefined ||
        item.user_id !== undefined ||
        item.user_external_id !== undefined
      ) {
        throw new BadRequestException(
          `createElevenlabsMedia() items[${idx}]: user/user_id/user_external_id are forbidden for elevenlabs source`,
        );
      }

      if (
        item.voice_id !== undefined &&
        (typeof item.voice_id !== 'string' || item.voice_id.length === 0)
      ) {
        throw new BadRequestException(
          `createElevenlabsMedia() items[${idx}].voice_id must be a non-empty string`,
        );
      }
      if (
        item.model_id !== undefined &&
        (typeof item.model_id !== 'string' || item.model_id.length === 0)
      ) {
        throw new BadRequestException(
          `createElevenlabsMedia() items[${idx}].model_id must be a non-empty string`,
        );
      }
      if (
        item.language_code !== undefined &&
        (typeof item.language_code !== 'string' ||
          item.language_code.length === 0)
      ) {
        throw new BadRequestException(
          `createElevenlabsMedia() items[${idx}].language_code must be a non-empty string`,
        );
      }

      if (item.voice_settings !== undefined) {
        if (
          typeof item.voice_settings !== 'object' ||
          item.voice_settings === null
        ) {
          throw new BadRequestException(
            `createElevenlabsMedia() items[${idx}].voice_settings must be an object`,
          );
        }
        const vs = item.voice_settings as Record<string, unknown>;
        if (
          vs.stability !== undefined &&
          (typeof vs.stability !== 'number' ||
            vs.stability < 0 ||
            vs.stability > 1)
        ) {
          throw new BadRequestException(
            `createElevenlabsMedia() items[${idx}].voice_settings.stability must be a number between 0.0 and 1.0`,
          );
        }
        if (
          vs.similarity_boost !== undefined &&
          (typeof vs.similarity_boost !== 'number' ||
            vs.similarity_boost < 0 ||
            vs.similarity_boost > 1)
        ) {
          throw new BadRequestException(
            `createElevenlabsMedia() items[${idx}].voice_settings.similarity_boost must be a number between 0.0 and 1.0`,
          );
        }
        if (
          vs.style !== undefined &&
          (typeof vs.style !== 'number' || vs.style < 0 || vs.style > 1)
        ) {
          throw new BadRequestException(
            `createElevenlabsMedia() items[${idx}].voice_settings.style must be a number between 0.0 and 1.0`,
          );
        }
        if (
          vs.speed !== undefined &&
          (typeof vs.speed !== 'number' || vs.speed < 0.7 || vs.speed > 1.2)
        ) {
          throw new BadRequestException(
            `createElevenlabsMedia() items[${idx}].voice_settings.speed must be a number between 0.7 and 1.2`,
          );
        }
        if (
          vs.use_speaker_boost !== undefined &&
          typeof vs.use_speaker_boost !== 'boolean'
        ) {
          throw new BadRequestException(
            `createElevenlabsMedia() items[${idx}].voice_settings.use_speaker_boost must be a boolean`,
          );
        }
      }

      return {
        state_transition_id: item.state_transition_id,
        script_text: item.script_text,
        voice_id: item.voice_id,
        model_id: item.model_id,
        language_code: item.language_code,
        voice_settings: item.voice_settings,
      } as CreateElevenlabsMediaItem;
    },
  );

  return { items: validated };
}

export function assertValidMediaStatus(
  status: string,
): asserts status is MediaStatus {
  if (!VALID_MEDIA_STATUSES.includes(status as MediaStatus)) {
    throw new BadRequestException(
      `Invalid media status "${status}". Must be one of: ${VALID_MEDIA_STATUSES.join(', ')}`,
    );
  }
}

export function assertValidMediaType(
  mediaType: string,
): asserts mediaType is MediaType {
  if (!VALID_MEDIA_TYPES.includes(mediaType as MediaType)) {
    throw new BadRequestException(
      `Invalid media type "${mediaType}". Must be one of: ${VALID_MEDIA_TYPES.join(', ')}`,
    );
  }
}

export function assertValidMediaSource(
  source: string,
): asserts source is MediaSource {
  if (!VALID_MEDIA_SOURCES.includes(source as MediaSource)) {
    throw new BadRequestException(
      `Invalid media source "${source}". Must be one of: ${VALID_MEDIA_SOURCES.join(', ')}`,
    );
  }
}
