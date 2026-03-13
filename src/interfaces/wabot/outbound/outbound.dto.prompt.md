// pp-sketch/src/wabot/outbound/outbound.dto.prompt.md

DownloadMediaRequest — the JSON body pp sends to wabot's downloadMedia endpoint.
{
  media_url: string;                       // WhatsApp CDN URL (from webhook audio.url)
  otel: { carrier: Record<string, string> };
}

DownloadMediaResponse — wabot streams the response back.
* HTTP response body: raw binary audio bytes (streamed, not buffered).
* HTTP response header content-type: the mime type of the media (e.g. "audio/ogg; codecs=opus").
