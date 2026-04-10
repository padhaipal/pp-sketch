// pp-sketch/src/interfaces/stt/reverie/reverie.service.prompt.md

// Reverie speech-to-text service.
// Uses the Reverie File API (POST, synchronous) for transcription.
// Called in parallel with other STT services from createWhatsappAudioMedia (step 4).
// Environment variables: REVERIE_API_KEY, REVERIE_APP_ID, STT_TIME_CAP (.env, seconds).
// See src/docs/feature-flags.md — gated by `stt.reverie.enabled`.

run(audioStream: NodeJS.ReadableStream, parentMedia: MediaMetaData): Promise<MediaMetaData>

1.) Buffer audioStream into a single Buffer.
  * If the stream errors or is empty: log WARN with parentMedia.id and throw.

2.) POST multipart/form-data to `https://revapi.reverieinc.com/`:
  * Headers:
    - REV-API-KEY: ${REVERIE_API_KEY}
    - REV-APP-ID: ${REVERIE_APP_ID}
    - REV-APPNAME: `stt_file`
    - src_lang: `hi` (Hindi — PadhaiPal's primary instructional language)
    - domain: `generic`
    - format: `ogg_opus` (WhatsApp voice messages are OGG/Opus encoded)
    - logging: `false` (do not store audio or transcripts on Reverie's servers)
    - punctuate: `true`
  * Form field:
    - audio_file: the buffered audio bytes (filename: `${parentMedia.id}.ogg`).
  * Timeout: STT_TIME_CAP seconds. Enforce with AbortController; abort on timeout.

3.) Handle response:
  * Parse JSON. Response shape: `{ id: string, success: boolean, final: boolean, text: string, display_text: string, confidence: number, cause: string }`.
  * If success === false: log WARN (cause, parentMedia.id). Throw.
  * If success === true and final === true: proceed to step 4.
  * On HTTP error / timeout / network error: log WARN (details, parentMedia.id). Throw.

4.) Create the transcript entity via mediaMetaDataService.createTextMedia():
  * text = response.display_text (post-processed transcript with number normalisation and punctuation)
  * user: pass parentMedia.user_id as user: { id: parentMedia.user_id } (trusted path — no DB hit)
  * source = 'reverie'
  * input_media_id = parentMedia.id
  * media_details = { raw_text: response.text, confidence: response.confidence, reverie_request_id: response.id, cause: response.cause }
  Note: the service must inject MediaMetaDataService (not DataSource directly).

5.) Return the created MediaMetaData entity.

// Error contract: if run() throws, the caller (createWhatsappAudioMedia) treats this provider
// as failed for this attempt. This service must NOT swallow errors — always re-throw so the
// caller can track which providers succeeded vs failed/timed-out.
