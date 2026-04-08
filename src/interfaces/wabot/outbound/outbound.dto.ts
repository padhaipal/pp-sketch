import type { OtelCarrier } from '../../../otel/otel.dto';

export interface OutboundMediaItem {
  type: 'audio' | 'video' | 'image' | 'sticker' | 'text';
  url?: string;
  body?: string;
  // Optional mime hint. wabot promotes type='image' + mime_type='image/webp' to a sticker.
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
