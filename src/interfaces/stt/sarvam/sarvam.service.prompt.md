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

4.) Create the transcript entity via mediaMetaDataService.createTextMedia():
  * text = response.transcript (may be empty string if no speech detected)
  * user: pass parentMedia.user_id via user_external_id (or resolve to a User object if available from caller context — see note below)
  * source = 'sarvam'
  * input_media_id = parentMedia.id
  * media_details = { language_code: response.language_code, language_probability: response.language_probability, sarvam_request_id: response.request_id }
  Note: the service must inject MediaMetaDataService (not DataSource directly). Since parentMedia only has user_id (not a full User object), the simplest approach is to pass it as user: { id: parentMedia.user_id } (trusted path — no DB hit).

5.) Return the created MediaMetaData entity.

// Error contract: if run() throws, the caller (createWhatsappAudioMedia) treats this provider
// as failed for this attempt. This service must NOT swallow errors — always re-throw so the
// caller can track which providers succeeded vs failed/timed-out.
