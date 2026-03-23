// pp-sketch/src/wabot/outbound/outbound.dto.prompt.md

// --- SendMessage request ---
// Sent from pp to wabot's sendMessage endpoint.
// Carries an ordered list of media items to deliver to the student as individual WhatsApp messages.

SendMessageRequest — the JSON body pp sends to wabot's sendMessage endpoint.
{
  user_external_id: string;                // student's WhatsApp phone number (user.external_id)
  wamid: string;                           // the WhatsApp message ID being replied to (payload.message.id)
  consecutive?: boolean;                   // true if this is responding to a consecutive message
  media: OutboundMediaItem[];              // ordered list — wabot sends each item to WhatsApp in this order
  otel: { carrier: Record<string, string> };
}

OutboundMediaItem — one media message to send.
{
  type: 'audio' | 'video' | 'image' | 'text';
  url?: string;                            // WhatsApp media reference — either an external URL (starts with "http") or a WhatsApp media ID (from preloaded upload). Required for audio, video, image; absent for text.
  body?: string;                           // text content — required for text type; absent for audio, video, image
}

// type → field rules (enforced at wabot validation layer):
//   'text'                       — body is REQUIRED, url is absent
//   'audio' | 'video' | 'image'  — url is REQUIRED, body is absent

SendMessageResponse — wabot's response.
* 200 `{ delivered: true }` — all messages were sent to WhatsApp.
* 200 `{ delivered: false, reason: "inflight-expired" }` — inflight window expired, fallback was already sent.
* 4XX — WhatsApp client error (passed through from the first failing message).
* 5XX — WhatsApp server error (passed through after retry exhaustion).

// --- DownloadMedia request ---

DownloadMediaRequest — the JSON body pp sends to wabot's downloadMedia endpoint.
{
  media_url: string;                       // WhatsApp CDN URL (from webhook audio.url)
  otel: { carrier: Record<string, string> };
}

DownloadMediaResponse — wabot streams the response back.
* HTTP response body: raw binary audio bytes (streamed, not buffered).
* HTTP response header content-type: the mime type of the media (e.g. "audio/ogg; codecs=opus").

// --- UploadMedia request ---
// Sent from pp to wabot's uploadMedia endpoint.
// Carries raw media bytes to be uploaded to WhatsApp's servers.

UploadMediaRequest — raw binary body with metadata in headers.
* HTTP request body: raw binary bytes (the media file contents).
* HTTP request header Content-Type: the mime type of the media (e.g. "audio/mpeg", "video/mp4").
* HTTP request header X-Media-Type: the WhatsApp media type ("audio", "video", "image").
* HTTP request query param ?otel=<JSON>: serialized OTel carrier for distributed tracing.

UploadMediaResponse — wabot's JSON response.
* 200 `{ wa_media_url: string }` — the WhatsApp media ID returned by the Cloud API. Use this value in sendMessage's OutboundMediaItem.url to reference the preloaded media.
* 4XX — WhatsApp client error (passed through).
* 5XX — WhatsApp server error (passed through).
