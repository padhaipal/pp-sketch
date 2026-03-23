// pp-sketch/src/media-meta-data/whatsapp-preload.processor.prompt.md

// WHATSAPP_PRELOAD BullMQ worker.
// Handles both initial preload (after HeyGen generation) and periodic reload (every 20 days to prevent WhatsApp media expiry).
// Job payload shape: WhatsappPreloadJobDto (see media-meta-data.dto.prompt.md).

// WhatsApp media IDs expire after 30 days. The reload cycle runs every 20 days to maintain a 10-day safety buffer.

processJob(job)

1.) Extract { media_metadata_id, s3_key, reload } from job payload.

2.) Look up the media_metadata row by id = media_metadata_id.
    * If not found: log WARN, complete the job (no-op — entity may have been deleted).
    * If rolled_back = true: log WARN, complete the job (no-op — entity was rolled back).
    * If status = 'failed': log WARN, complete the job (no-op — entity failed upstream).

3.) Call src/interfaces/media-bucket/outbound/outbound.service.ts/getBuffer(s3_key) to fetch the raw media bytes and content_type from S3.
    * If getBuffer() throws: log ERROR, fail the job (BullMQ retries with backoff).

4.) Determine the WhatsApp media_type from the media_metadata row's media_type field ('audio', 'video', or 'image').

5.) Call src/interfaces/wabot/outbound/outbound.service.ts/uploadMedia(buffer, content_type, media_type, otel_carrier).
    * On success: extract wa_media_url from the response.
    * If uploadMedia() throws with a 4XX error: log ERROR, update media_metadata status = 'failed', fail the job (no retry — client error).
    * If uploadMedia() throws with a 5XX error: log WARN, fail the job (BullMQ retries with backoff).

6.) Update the media_metadata row (single update):
    * wa_media_url = returned wa_media_url.
    * If reload is falsy (initial preload): set status = 'ready'.
    * If reload is truthy: leave status unchanged (already 'ready').

7.) Enqueue a new job on the WHATSAPP_PRELOAD queue with { media_metadata_id, s3_key, reload: true } and a delay of 20 days (20 * 24 * 60 * 60 * 1000 ms).

8.) Mark the BullMQ job as complete.
