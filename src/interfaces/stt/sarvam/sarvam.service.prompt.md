// pp-sketch/src/interfaces/stt/sarvam/sarvam.service.prompt.md

// Sarvam speech-to-text service.
// Uses the Sarvam REST API (model saaras:v3) for synchronous transcription.
// Called in parallel with other STT services from createWhatsappAudioMedia (step 4).
// Environment variables: SARVAM_API_KEY (.env), STT_TIME_CAP (.env, seconds).
// See src/docs/feature-flags.md — gated by `stt.sarvam.enabled`.

run(audioStream: NodeJS.ReadableStream, parentMedia: MediaMetaData): Promise<MediaMetaData>

1.) Buffer audioStream into a single Buffer.
  * If the stream errors or is empty: log WARN with parentMedia.id and throw.

2.) POST multipart/form-data to `https://api.sarvam.ai/speech-to-text`:
  * Header: `api-subscription-key: ${SARVAM_API_KEY}`.
  * Form fields:
    - file: the buffered audio bytes (filename: `${parentMedia.id}.ogg`, content-type: parentMedia.media_details?.mime_type ?? 'audio/ogg').
    - model: `saaras:v3`.
    - mode: `transcribe`.
    - language_code: `unknown` (auto-detect; Sarvam supports 22 Indian languages + English).
  * Timeout: STT_TIME_CAP seconds. Enforce with AbortController; abort on timeout.

3.) Handle response:
  * 2XX — parse JSON. Response shape: `{ request_id: string, transcript: string, language_code: string | null, language_probability: number | null }`.
  * 4XX — log WARN (status, error body, parentMedia.id). Throw.
  * 5XX / timeout / network error — log WARN (details, parentMedia.id). Throw.

4.) Create the transcript entity via `@InjectRepository(MediaMetaDataEntity)` Repository:
  * Uses `mediaRepo.create()` + `mediaRepo.save()` to insert the text entity.
  * Fields: id = uuid(), media_type = 'text', source = 'sarvam', status = 'ready', text = response.transcript, input_media_id = parentMedia.id, user_id = parentMedia.user_id, rolled_back = false, media_details = { language_code, language_probability, sarvam_request_id }.
  Note: this service injects the MediaMetaDataEntity repository directly (not MediaMetaDataService or DataSource).

5.) Return the created MediaMetaData entity.

// Error contract: if run() throws, the caller (createWhatsappAudioMedia) treats this provider
// as failed for this attempt. This service must NOT swallow errors — always re-throw so the
// caller can track which providers succeeded vs failed/timed-out.
