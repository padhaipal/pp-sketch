sendMessage(options: { user_external_id: string; wamid: string; consecutive?: boolean; media: OutboundMediaItem[]; otel_carrier: Record<string, string> }): Promise<{ status: number; body: { delivered: boolean; reason?: string } }>
WABOT_INTERNAL_BASE_URL is available in .env.
Request shape: see src/wabot/outbound/outbound.dto.prompt.md SendMessageRequest.
* Build the SendMessageRequest body from the options.
* POST to ${WABOT_INTERNAL_BASE_URL}/sendMessage.
* Return { status: response HTTP status, body: parsed response JSON }.

downloadMedia(media_url: string, otel_carrier: Record<string, string>): Promise<{ stream: NodeJS.ReadableStream, content_type: string }>
WABOT_INTERNAL_BASE_URL is available in .env.
Request shape: see src/wabot/outbound/outbound.dto.prompt.md DownloadMediaRequest.
* POST to ${WABOT_INTERNAL_BASE_URL}/downloadMedia with body: { media_url, otel: { carrier: otel_carrier } }.
* Expect a streaming response. Do not buffer the full response body.
* On 2XX: return { stream: response body as a readable stream, content_type: response content-type header value }.
* On 4XX: log ERROR and throw.
* On 5XX: log WARN and throw.
