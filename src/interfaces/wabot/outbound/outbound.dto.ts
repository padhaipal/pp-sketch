import type { OtelCarrier } from '../../../otel/otel.dto';

export interface OutboundMediaItem {
  type: 'audio' | 'video' | 'image' | 'sticker' | 'text';
  url?: string;
  body?: string;
  // Optional MIME type hint (informational).
  mime_type?: string;
}

export interface SendMessageRequest {
  user_external_id: string;
  wamid: string;
  consecutive?: boolean;
  media: OutboundMediaItem[];
  otel: { carrier: OtelCarrier };
}

export interface SendMessageResponse {
  delivered: boolean;
  reason?: string;
}

export interface DownloadMediaRequest {
  media_url: string;
  otel: { carrier: OtelCarrier };
}

export interface UploadMediaResponse {
  wa_media_url: string;
}

export interface SendNotificationRequest {
  user_external_id: string;
  media: OutboundMediaItem[];
}

export interface SendNotificationResponse {
  status: number;
  delivered: boolean;
  error_code?: number;
}
