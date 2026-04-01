import type { OtelCarrier } from '../../../otel/otel.dto';

export interface OutboundMediaItem {
  type: 'audio' | 'video' | 'image' | 'text';
  url?: string;
  body?: string;
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
