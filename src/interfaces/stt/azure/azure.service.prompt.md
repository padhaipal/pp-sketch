// pp-sketch/src/interfaces/stt/azure/azure.service.prompt.md

// Azure speech-to-text service.
// Uses the Azure Fast Transcription API (synchronous, api-version 2025-10-15).
// Called in parallel with other STT services from createWhatsappAudioMedia (step 4).
// Environment variables: AZURE_SPEECH_ENDPOINT, AZURE_SPEECH_KEY, STT_TIME_CAP (.env, seconds).
// See src/docs/feature-flags.md — gated by `stt.azure.enabled`.

run(audioStream: NodeJS.ReadableStream, parentMedia: MediaMetaData): Promise<MediaMetaData>

1.) Buffer audioStream into a single Buffer.
  * If the stream errors or is empty: log WARN with parentMedia.id and throw.

2.) POST multipart/form-data to `${AZURE_SPEECH_ENDPOINT}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`:
  * Header: `Ocp-Apim-Subscription-Key: ${AZURE_SPEECH_KEY}`.
  * Form fields:
    - audio: the buffered audio bytes (filename: `${parentMedia.id}.ogg`, content-type: parentMedia.media_details?.mime_type ?? 'audio/ogg').
    - definition: JSON.stringify({ locales: ["hi-IN"] }). Hindi is PadhaiPal's primary instructional language; specifying a single locale improves accuracy and reduces latency. Azure auto-detects OGG/Opus codec.
  * Timeout: STT_TIME_CAP seconds. Enforce with AbortController; abort on timeout.

3.) Handle response:
  * 200 — parse JSON. Response shape: `{ durationMilliseconds: number, combinedPhrases: [{ text: string }], phrases: [{ text: string, locale: string, confidence: number }] }`.
    Extract transcript from combinedPhrases[0].text. If combinedPhrases is empty or text is absent: treat as no speech detected (empty string).
  * Non-200 — parse error JSON: `{ error: { code: string, message: string } }`. Log WARN (status, error.code, error.message, parentMedia.id). Throw.
  * Timeout / network error — log WARN (details, parentMedia.id). Throw.

4.) Create the transcript entity via mediaMetaDataService.createTextMedia():
  * text = combinedPhrases[0].text (display form — Azure returns punctuated, capitalised text; may be empty string if no speech detected)
  * user: pass parentMedia.user_id as user: { id: parentMedia.user_id } (trusted path — no DB hit)
  * source = 'azure'
  * input_media_id = parentMedia.id
  * media_details = { duration_ms: response.durationMilliseconds, locale: phrases[0]?.locale ?? null, confidence: average of phrases[].confidence (null if no phrases) }
  Note: the service must inject MediaMetaDataService (not DataSource directly).

5.) Return the created MediaMetaData entity.

// Error contract: if run() throws, the caller (createWhatsappAudioMedia) treats this provider
// as failed for this attempt. This service must NOT swallow errors — always re-throw so the
// caller can track which providers succeeded vs failed/timed-out.
