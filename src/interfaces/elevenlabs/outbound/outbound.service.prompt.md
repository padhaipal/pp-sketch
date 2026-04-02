// pp-sketch/src/interfaces/elevenlabs/outbound/outbound.service.prompt.md

// ELEVENLABS_GENERATE BullMQ worker.
// Dequeues jobs and calls ElevenLabs TTS API. Audio returned synchronously in HTTP response body (binary).
// Job payload shape: see src/media-meta-data/media-meta-data.service.prompt.md (createElevenlabsMedia step 2).

// Environment variables:
//   ELEVENLABS_API_KEY   — sent as xi-api-key header
//   ELEVENLABS_VOICE_ID  — default voice_id (path param)

// =====================================================================
// processJob(job)
// =====================================================================

// 0.) Start a child span: startChildSpan('elevenlabs-generate-processor', job.data.otel_carrier). See src/otel/otel.prompt.md for helpers.

// 1.) Extract from job payload: media_metadata_id and elevenlabs_params.

// 2.) Build request:
//     * voice_id = elevenlabs_params.voice_id ?? ELEVENLABS_VOICE_ID (path param)
//     * body = TtsRequest (see outbound.dto.prompt.md):
//       - text = elevenlabs_params.script_text
//       - model_id = elevenlabs_params.model_id (if provided)
//       - language_code = elevenlabs_params.language_code (if provided)
//       - voice_settings = elevenlabs_params.voice_settings (if provided)

// 3.) POST to https://api.elevenlabs.io/v1/text-to-speech/${voice_id}?output_format=mp3_44100_128
//     Headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' }

// 4.) On 200:
//     * Response body is raw audio binary (NOT JSON).
//     * Stream response body to src/interfaces/media-bucket/outbound/outbound.service.ts/stream() with content_type 'audio/mpeg'.
//     * Get byte_size from Content-Length header if available.
//     * Update the media_metadata row:
//       - s3_key = returned S3 key
//       - media_details = { mime_type: 'audio/mpeg', byte_size }
//       - status = 'queued' (NOT 'ready' — WHATSAPP_PRELOAD worker sets 'ready')
//     * Enqueue a job on the WHATSAPP_PRELOAD queue with { media_metadata_id, s3_key, otel_carrier: injectCarrier(span) }.
//     * End the span. Mark BullMQ job as complete.

// 5.) On 4XX (422 etc):
//     * Log ERROR with response body.
//     * Update media_metadata row: status = 'failed', media_details = { error: response body }.
//     * End the span. Fail the job (no retry — client error).

// 6.) On 5XX:
//     * Log WARN with response body.
//     * If final attempt: log ERROR, update media_metadata status = 'failed'.
//     * End the span. Fail the job so BullMQ retries with backoff.
