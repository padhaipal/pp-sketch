// pp-sketch/src/interfaces/heygen/inbound/inbound.dto.prompt.md

import {
  IsIn,
  IsNotEmptyObject,
  IsOptional,
  IsString,
} from 'class-validator';

// --- Webhook payload shapes ---
// HeyGen sends a POST with JSON body to the registered webhook endpoint.
// Signature verification: HMAC-SHA256 of the raw request body using HEYGEN_WEBHOOK_SECRET,
// compared against the `Signature` header.

// --- Event types we handle ---
// 'avatar_video.success' — video rendering completed
// 'avatar_video.fail'    — video rendering failed

// --- Success event data ---

export class VideoSuccessEventDataDto {
  @IsString()
  video_id!: string;

  @IsString()
  url!: string;                            // temporary download URL for the rendered video

  @IsOptional()
  @IsString()
  gif_download_url?: string;

  @IsOptional()
  @IsString()
  video_share_page_url?: string;

  @IsOptional()
  @IsString()
  folder_id?: string;

  @IsOptional()
  @IsString()
  callback_id?: string;                   // media_metadata.id — set during video generation
}

// --- Fail event data ---

export class VideoFailEventDataDto {
  @IsString()
  video_id!: string;

  @IsString()
  msg!: string;                            // failure reason from HeyGen

  @IsOptional()
  @IsString()
  callback_id?: string;                   // media_metadata.id
}

// --- Webhook payload ---
// Discriminated on event_type. event_data shape depends on event_type.
// The controller validates only the top-level shape (event_type + event_data is present).
// The processor validates event_data fields per event_type using VideoSuccessEventDataDto / VideoFailEventDataDto.

export class HeygenWebhookDto {
  @IsString()
  @IsIn(['avatar_video.success', 'avatar_video.fail'])
  event_type!: 'avatar_video.success' | 'avatar_video.fail';

  @IsNotEmptyObject()                     // ensures event_data is a non-null, non-empty object
  event_data!: Record<string, unknown>;   // detailed validation happens in the processor per event_type
}

// --- BullMQ job payload ---
// The inbound controller enqueues this on the HEYGEN_INBOUND queue.

export class HeygenInboundJobDto {
  @IsString()
  @IsIn(['avatar_video.success', 'avatar_video.fail'])
  event_type!: 'avatar_video.success' | 'avatar_video.fail';

  event_data!: Record<string, unknown>;   // raw event_data — processor validates per event_type
}
