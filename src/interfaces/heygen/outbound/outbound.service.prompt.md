// pp-sketch/src/interfaces/heygen/outbound/outbound.service.prompt.md

// HEYGEN_GENERATE BullMQ worker.
// Dequeues jobs and dispatches to the correct HeyGen endpoint based on media_type.
// Job payload shape: see src/media-meta-data/media-meta-data.service.prompt.md (createHeygenMedia step 2).
//
// DB access: receives `Repository<MediaMetaDataEntity>` (not DataSource). Uses repo.update() for all queries.

// Environment variables:
//   HEYGEN_API_KEY      — sent as X-Api-Key header on every request
//   HEYGEN_AVATAR_ID    — default avatar_id for video generation
//   HEYGEN_VOICE_ID     — default voice_id for TTS and video voice
//   HEYGEN_CALLBACK_URL — URL HeyGen posts to on avatar_video.success / avatar_video.fail

// =====================================================================
// processJob(job)
// =====================================================================

// 0.) Start a child span: startChildSpan('heygen-generate-processor', job.data.otel_carrier). See src/otel/otel.prompt.md for helpers.

// 1.) Extract from job payload: media_metadata_id, media_type, and heygen_params.

// 2.) Dispatch based on media_type:

// --- media_type = 'video' ---

// a.) Build a VideoGenerateRequest (see outbound.dto.prompt.md):
//     * video_inputs: single scene with:
//       - character.type = 'avatar'
//       - character.avatar_id = heygen_params.avatar_id ?? HEYGEN_AVATAR_ID
//       - character.avatar_style = heygen_params.avatar_style ?? 'normal'
//       - voice.type = 'text'
//       - voice.voice_id = heygen_params.voice_id ?? HEYGEN_VOICE_ID
//       - voice.input_text = heygen_params.script_text
//       - voice.speed = heygen_params.speed (if provided)
//       - voice.emotion = heygen_params.emotion (if provided)
//       - voice.locale = heygen_params.locale (if provided)
//       - background = heygen_params.background (if provided)
//     * callback_id = media_metadata_id (so webhook can correlate)
//     * callback_url = HEYGEN_CALLBACK_URL
//     * title = heygen_params.title (if provided)
//     * dimension = heygen_params.dimension ?? { width: 1920, height: 1080 }

// b.) POST to https://api.heygen.com/v2/video/generate
//     Headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' }

// c.) On 200:
//     * Extract video_id from response.data.video_id.
//     * Update the media_metadata row: set media_details = { video_id }, keep status = 'queued'.
//     * End the span. Mark the BullMQ job as complete. (Actual media download happens when webhook fires.)

// d.) On 4XX:
//     * Log ERROR with response body.
//     * Update media_metadata row: status = 'failed', media_details = { error: response.error }.
//     * End the span. Fail the job (no retry — client error).

// e.) On 5XX:
//     * Log WARN with response body.
//     * End the span. Fail the job so BullMQ retries it with backoff.

// --- media_type = 'audio' ---

// a.) Build a TtsRequest (see outbound.dto.prompt.md):
//     * text = heygen_params.script_text
//     * voice_id = heygen_params.voice_id ?? HEYGEN_VOICE_ID
//     * speed = String(heygen_params.speed) (if provided — TTS API expects a string, job payload has a number)
//     * language = heygen_params.language (if provided)
//     * locale = heygen_params.locale (if provided)

// b.) POST to https://api.heygen.com/v1/audio/text_to_speech
//     Headers: { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' }

// c.) On 200:
//     * Extract audio_url, duration from response.data.
//     * Download the audio file from audio_url as a readable stream.
//     * Stream it to src/interfaces/media-bucket/outbound/outbound.service.ts/stream() to upload to S3.
//     * Update the media_metadata row:
//       - s3_key = returned S3 key
//       - media_details = { mime_type: 'audio/mpeg', duration, byte_size, request_id, word_timestamps }
//       - status stays 'queued' (NOT 'ready' — the WHATSAPP_PRELOAD worker sets 'ready' after populating wa_media_url)
//     * Enqueue a job on the WHATSAPP_PRELOAD queue with { media_metadata_id, s3_key, otel_carrier: injectCarrier(span) }.
//       (The WHATSAPP_PRELOAD worker will upload the media to WhatsApp, set wa_media_url, and transition status to 'ready'. See src/media-meta-data/whatsapp-preload.processor.prompt.md.)
//     * End the span. Mark the BullMQ job as complete.

// d.) On 4XX:
//     * Log ERROR with response body.
//     * Update media_metadata row: status = 'failed', media_details = { error: response.error }.
//     * End the span. Fail the job (no retry — client error).

// e.) On 5XX:
//     * Log WARN with response body.
//     * End the span. Fail the job so BullMQ retries it with backoff.
