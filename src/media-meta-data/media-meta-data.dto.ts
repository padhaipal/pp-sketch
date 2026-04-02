import { BadRequestException } from '@nestjs/common';
import type { OtelCarrier } from '../otel/otel.dto';
import { User } from '../users/user.dto';

const VALID_MEDIA_STATUSES = ['created', 'queued', 'ready', 'failed'] as const;
export type MediaStatus = (typeof VALID_MEDIA_STATUSES)[number];

const VALID_MEDIA_TYPES = ['audio', 'text', 'video', 'image'] as const;
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
  media_details?: Record<string, unknown>;
  user_id?: string | null;
  input_media_id?: string | null;
  generation_request_json?: Record<string, unknown> | null;
  rolled_back: boolean;
  created_at: Date;
}

export interface CreateWhatsappAudioMediaOptions {
  wa_media_url: string;
  user?: User;
  user_external_id?: string;
  media_details?: Record<string, unknown>;
  otel_carrier: OtelCarrier;
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

const VALID_STATIC_MEDIA_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'video/mp4',
] as const;
type StaticMediaMimeType = (typeof VALID_STATIC_MEDIA_MIME_TYPES)[number];

const MIME_TO_MEDIA_TYPE: Record<StaticMediaMimeType, MediaType> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'video/mp4': 'video',
};

const STATIC_MEDIA_MAX_BYTES: Record<'image' | 'video', number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
};

export interface UploadStaticMediaItem {
  state_transition_id: string;
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
    (typeof o.user_external_id !== 'string' ||
      (o.user_external_id as string).length === 0)
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
      (o.media_metadata_id as string).length === 0)
  ) {
    throw new BadRequestException(
      'findTranscripts() options.media_metadata_id must be a non-empty string',
    );
  }
  if (
    hasWaMediaUrl &&
    (typeof o.media_metadata_wa_media_url !== 'string' ||
      (o.media_metadata_wa_media_url as string).length === 0)
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
const VALID_EMOTIONS: Array<
  NonNullable<CreateHeygenMediaItem['emotion']>
> = ['Excited', 'Friendly', 'Serious', 'Soothing', 'Broadcaster'];
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
        if (
          !VALID_BG_TYPES.includes(bg.type as 'color' | 'image' | 'video')
        ) {
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
    return { state_transition_id: item.state_transition_id };
  });
}

export function assertValidStaticMediaFile(
  file: { mimetype: string; size: number },
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
  const maxBytes = STATIC_MEDIA_MAX_BYTES[media_type as 'image' | 'video'];
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
