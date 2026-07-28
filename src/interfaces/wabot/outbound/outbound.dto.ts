import type { OtelCarrier } from '../../../otel/otel.dto';

// Entry screen id of the once-published comprehension flow asset. Keep in
// sync with wabot-sketch/scripts/publish-flow.ts (the flow JSON) and the
// wabot outbound DTO mirror.
export const COMPREHENSION_FLOW_SCREEN = 'COMPREHENSION';

// One answer option injected into the flow at send time. title is the fixed
// letter (A-D, assigned after the per-send shuffle); description carries the
// answer text (WhatsApp caps it at 300 chars); id is the option entity's
// media_metadata id, echoed back in the nfm_reply as answer_id.
export interface OutboundFlowOption {
  id: string;
  title: string;
  description: string;
}

// Payload for a WhatsApp Flow message (interactive/flow on the wire). The
// asset is published once; everything dynamic arrives via `data`
// (flow_action_payload.data on the navigate action) — no flow data endpoint.
export interface OutboundFlowData {
  flow_id: string;
  /** Flow message body text shown above the CTA button. */
  body: string;
  /** CTA button label (≤ 30 chars per Meta guidance). */
  cta: string;
  /** Entry screen id (COMPREHENSION_FLOW_SCREEN). */
  screen: string;
  data: {
    question_text: string;
    options: OutboundFlowOption[];
  };
}

export interface OutboundMediaItem {
  type: 'audio' | 'video' | 'image' | 'sticker' | 'text' | 'flow';
  url?: string;
  body?: string;
  // Optional MIME type hint (informational).
  mime_type?: string;
  // Required when type === 'flow'.
  flow?: OutboundFlowData;
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
