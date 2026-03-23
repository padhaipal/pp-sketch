// pp-sketch/src/interfaces/heygen/inbound/inbound.processor.prompt.md

// HEYGEN_INBOUND BullMQ worker.
// Processes completed/failed HeyGen video generation callbacks.
// Job payload shape: HeygenInboundJobDto (see inbound.dto.prompt.md).

processJob(job)

1.) Extract event_type and event_data from the job payload.

2.) Switch on event_type:

// --- avatar_video.success ---

a.) Validate event_data fields: video_id (string), url (string), callback_id (string).
    * If callback_id is missing or empty: log ERROR, fail the job.

b.) Look up the media_metadata row by id = callback_id.
    * If not found: log ERROR, fail the job.

c.) Download the video from event_data.url as a readable stream.

d.) Stream it to src/interfaces/media-bucket/outbound/outbound.service.ts/stream() to upload to S3.
    * If upload fails: log ERROR, update media_metadata status = 'failed', fail the job.

e.) Update the media_metadata row (single update):
    * s3_key = returned S3 key
    * media_details = merge existing media_details with:
      - video_url (original HeyGen URL, for reference)
      - mime_type: 'video/mp4'
      - byte_size (from download if available)
    * status stays 'queued' (NOT 'ready' — the WHATSAPP_PRELOAD worker sets 'ready' after populating wa_media_url)

f.) Enqueue a job on the WHATSAPP_PRELOAD queue with { media_metadata_id: callback_id, s3_key }.
    (The WHATSAPP_PRELOAD worker will upload the media to WhatsApp, set wa_media_url, and transition status to 'ready'. TODO: implement the worker.)

g.) Mark the BullMQ job as complete.

// --- avatar_video.fail ---

a.) Validate event_data fields: video_id (string), msg (string), callback_id (string).
    * If callback_id is missing or empty: log ERROR, fail the job.

b.) Look up the media_metadata row by id = callback_id.
    * If not found: log ERROR, fail the job.

c.) Update the media_metadata row:
    * status = 'failed'
    * media_details = merge existing media_details with { error_msg: event_data.msg }

d.) Log ERROR with video_id and failure message.

e.) Mark the BullMQ job as complete.
    (No retry — HeyGen has already given a terminal failure.)
