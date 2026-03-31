import {
  IsIn,
  IsNotEmptyObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class VideoSuccessEventDataDto {
  @IsString()
  video_id!: string;

  @IsString()
  url!: string;

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
  callback_id?: string;
}

export class VideoFailEventDataDto {
  @IsString()
  video_id!: string;

  @IsString()
  msg!: string;

  @IsOptional()
  @IsString()
  callback_id?: string;
}

export class HeygenWebhookDto {
  @IsString()
  @IsIn(['avatar_video.success', 'avatar_video.fail'])
  event_type!: 'avatar_video.success' | 'avatar_video.fail';

  @IsNotEmptyObject()
  event_data!: Record<string, unknown>;
}

export class HeygenInboundJobDto {
  @IsString()
  @IsIn(['avatar_video.success', 'avatar_video.fail'])
  event_type!: 'avatar_video.success' | 'avatar_video.fail';

  event_data!: Record<string, unknown>;

  otel_carrier!: Record<string, string>;
}
