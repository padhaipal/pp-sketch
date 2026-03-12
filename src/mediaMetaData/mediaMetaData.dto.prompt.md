// pp-sketch/src/mediaMetaData/mediaMetaData.dto.prompt.md

import { BadRequestException } from '@nestjs/common';
import { User } from '../users/user.dto';
import { AiProvider } from '../ai-providers/ai-provider.dto';

// --- Enums (match pg custom types) ---

export type MediaStatus = 'pending' | 'ready' | 'failed'; // media_status enum
export type MediaType = 'audio' | 'text' | 'video' | 'image'; // media_type enum

// --- Entity (matches pg media_metadata table) ---
// Note: for WhatsApp-sourced media, external_id is the mediaUrl that produced the media.

export interface MediaMetaData {
  id: string;                          // UUID PK
  external_id: string;                 // unique — origin identifier (WhatsApp mediaUrl for WA media)
  s3_key: string;                      // unique, object key in media-bucket
  status: MediaStatus;
  media_type: MediaType;
  media_details?: Record<string, unknown>; // JSONB, e.g. { mime_type, byte_size }
  user_id?: string | null;                 // FK -> users.id, null if AI-provided
  ai_provider_id?: string | null;          // FK -> ai_providers.id, null if user-provided
  input_media_id?: string | null;          // FK -> media_metadata.id, e.g. source image for a generated video
  generation_request_json?: Record<string, unknown> | null; // JSONB, request payload (no secrets)
  created_at: Date;                    // TIMESTAMPTZ, default now()
}

// --- Options types ---

// Exactly one of the user side (user / user_external_id) or the AI side (ai_provider / ai_provider_id)
// must be provided — not both sides, not neither.
// Within each side, entity = trusted (no DB hit), id/external_id = untrusted (DB lookup).
export interface CreateMediaMetaDataOptions {
  external_id: string;
  media_type: MediaType;
  source_url: string;                      // where to fetch the media from (e.g. WhatsApp CDN URL); not stored — service downloads and uploads to S3
  user?: User;                             // trusted — service uses .id directly
  user_external_id?: string;               // untrusted — service calls user.service.ts/find()
  ai_provider?: AiProvider;                // trusted — service uses .id directly
  ai_provider_id?: string;                 // untrusted — service calls ai_provider lookup
  input_media_id?: string;
  generation_request_json?: Record<string, unknown>;
  media_details?: Record<string, unknown>;
}

// --- Runtime validation ---

const VALID_MEDIA_TYPES: MediaType[] = ['audio', 'text', 'video', 'image'];

export function validateCreateMediaMetaDataOptions(options: unknown): CreateMediaMetaDataOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('create() options must be an object');
  }
  const o = options as Record<string, unknown>;

  if (typeof o.external_id !== 'string' || o.external_id.length === 0) {
    throw new BadRequestException('create() options.external_id is required and must be a non-empty string');
  }
  if (!VALID_MEDIA_TYPES.includes(o.media_type as MediaType)) {
    throw new BadRequestException(`create() options.media_type must be one of: ${VALID_MEDIA_TYPES.join(', ')}`);
  }
  if (typeof o.source_url !== 'string' || o.source_url.length === 0) {
    throw new BadRequestException('create() options.source_url is required and must be a non-empty string');
  }

  // Exactly one side: user (user or user_external_id) XOR AI (ai_provider or ai_provider_id)
  const hasUser = o.user !== undefined;
  const hasUserExternalId = o.user_external_id !== undefined;
  const hasAiProviderEntity = o.ai_provider !== undefined;
  const hasAiProviderId = o.ai_provider_id !== undefined;

  if (hasUser && hasUserExternalId) {
    throw new BadRequestException('create() requires at most one of user or user_external_id, not both');
  }
  if (hasAiProviderEntity && hasAiProviderId) {
    throw new BadRequestException('create() requires at most one of ai_provider or ai_provider_id, not both');
  }
  const hasUserSide = hasUser || hasUserExternalId;
  const hasAiSide = hasAiProviderEntity || hasAiProviderId;
  if (hasUserSide && hasAiSide) {
    throw new BadRequestException('create() requires exactly one of the user side (user / user_external_id) or the AI side (ai_provider / ai_provider_id), not both');
  }
  if (!hasUserSide && !hasAiSide) {
    throw new BadRequestException('create() requires exactly one of the user side (user / user_external_id) or the AI side (ai_provider / ai_provider_id)');
  }

  if (hasUser && (typeof o.user !== 'object' || o.user === null || typeof (o.user as User).id !== 'string')) {
    throw new BadRequestException('create() options.user must be a User object with a valid id');
  }
  if (hasUserExternalId && (typeof o.user_external_id !== 'string' || (o.user_external_id as string).length === 0)) {
    throw new BadRequestException('create() options.user_external_id must be a non-empty string');
  }
  if (hasAiProviderEntity && (typeof o.ai_provider !== 'object' || o.ai_provider === null || typeof (o.ai_provider as AiProvider).id !== 'string')) {
    throw new BadRequestException('create() options.ai_provider must be an AiProvider object with a valid id');
  }
  if (hasAiProviderId && (typeof o.ai_provider_id !== 'string' || (o.ai_provider_id as string).length === 0)) {
    throw new BadRequestException('create() options.ai_provider_id must be a non-empty string');
  }

  if (o.input_media_id !== undefined && typeof o.input_media_id !== 'string') {
    throw new BadRequestException('create() options.input_media_id must be a string');
  }
  if (o.generation_request_json !== undefined && (typeof o.generation_request_json !== 'object' || o.generation_request_json === null)) {
    throw new BadRequestException('create() options.generation_request_json must be an object');
  }
  if (o.media_details !== undefined && (typeof o.media_details !== 'object' || o.media_details === null)) {
    throw new BadRequestException('create() options.media_details must be an object');
  }

  return {
    external_id: o.external_id,
    media_type: o.media_type,
    source_url: o.source_url,
    user: o.user,
    user_external_id: o.user_external_id,
    ai_provider: o.ai_provider,
    ai_provider_id: o.ai_provider_id,
    input_media_id: o.input_media_id,
    generation_request_json: o.generation_request_json,
    media_details: o.media_details,
  } as CreateMediaMetaDataOptions;
}
