// pp-sketch/src/interfaces/stt/bodhan/bodhan.service.prompt.md

// Bodhan.ai speech-to-text service (model indic-transcribe, 2026-10).
// Called in parallel with the other STT services from createWhatsappAudioMedia (step 4),
// exactly like Sarvam: one text media_metadata row per call, source 'bodhan'.
// Environment variables: BODHAN_API_KEY (.env; Bodhan keys are per model — this is the
// indic-transcribe key, rotation = delete + create in console.bodhan.ai), STT_TIME_CAP
// (.env, seconds, shared by all STT). See src/docs/feature-flags.md — `stt.bodhan.enabled`,
// default ON (STT_DEFAULTS in media-meta-data.service.ts; no OpenFeature provider is
// registered, so the defaults are what runs on staging and prod).

run(audioBuffer: Buffer, parentMedia: MediaMetaData, userExternalId?: string): Promise<MediaMetaData>

1.) Empty buffer → log WARN `Bodhan: empty audio buffer for <id>` and throw. Load-test
    phone prefix → canned stub row via load-test-stub (no network call, no decode).

1b.) Ogg/Opus → 16 kHz mono 16-bit WAV via opus-to-wav.ts (`ogg-opus-decoder`, WASM,
    ESM-only → dynamic import; ~10 ms for a 5 s clip; a fresh decoder per call so
    concurrent notes never share state; WASM compiled once at boot in onModuleInit).
    WHY: Bodhan's vendor rejects Ogg/Opus and MP3 with 502 after 5–6 s (measured
    2026-10-02 with the staging key) but transcribes WAV in ~1.5 s. This runs ONLY in
    the Bodhan branch — Sarvam / Azure / Reverie still get the raw bytes, concurrently.
    Decode failure → WARN `Bodhan: opus decode failed for <id>: <msg>`, throw, outcome
    `decode`, nothing sent.

1c.) Length gate: durationMs ≥ 29 000 (from the decoded sample count) → WARN
    `Bodhan: clip <ms>ms ≥ 29000ms for <id> — not sent`, throw, outcome `rejected`, no
    network call (Bodhan's hard limit is 30 s; the margin covers rounding). The other
    engines still transcribe the note.

2.) Inside span `stt.bodhan` (attributes stt.provider, stt.model, media.id, audio.bytes,
    http.response.status_code, bodhan.x-ratelimit-* / retry-after when present, stt.outcome):
    POST multipart/form-data to `https://api.bodhan.ai/v1/audio/transcriptions`:
  * Header: `Authorization: Bearer ${BODHAN_API_KEY}`.
  * Form fields: file (the WAV, filename `${parentMedia.id}.wav`, type `audio/wav`),
    model `indic-transcribe`, language `hi`.
  * Timeout: STT_TIME_CAP seconds via AbortController — starts AFTER the decode.
  * Bodhan limits: audio ≤ 30 s, WAV works (OGG/MP3 are documented but rejected upstream),
    per-key requests-per-minute and parallel ceilings returned in x-ratelimit-* headers
    (not published as numbers).

3.) Handle response — every branch records pp.stt.request_duration_ms{provider="bodhan",outcome}:
  * 2XX `{ text }` → outcome ok. Missing text → WARN + throw (outcome error).
  * 429 → WARN `Bodhan 429 for <id>: rate-limited or out of credit (retry-after=…)` (both
    conditions return 429 at Bodhan), throw, outcome rate_limited.
  * 415 → WARN (duration unmeasurable / bad container), throw, outcome http_4xx-style
    `rejected` is reserved for the local length gate; 415 is logged as its own line.
  * other 4XX / 5XX → WARN with body, throw, outcome http_4xx / http_5xx.
  * abort → outcome timeout; other fetch errors → outcome network.
  * The first response per process logs `Bodhan: key allowance {…}` (INFO) so the key's
    rpm / parallel allowance is in Loki after each boot.

4.) Create the transcript entity via the injected MediaMetaDataEntity repository:
    id = uuid(), media_type 'text', source 'bodhan', status 'ready', text = response.text,
    input_media_id = parentMedia.id, user_id = parentMedia.user_id, rolled_back false,
    media_details = { model, language, upload_format 'wav-16k-mono', upload_bytes,
    duration_ms, rate_limit? (the headers snapshot) }. The stored audio row is untouched
    (still Ogg/Opus in the bucket).

5.) Return the saved entity.

// Error contract: identical to Sarvam — never swallow; the caller counts this provider as
// failed for the turn and proceeds with whichever engines succeeded. The lesson marks
// against the concatenation of all successful transcripts, so Bodhan's text takes part in
// marking from day one (no shadow mode).

// Grafana: PromQL
//   histogram_quantile(0.95, sum by (le) (rate(pp_stt_request_duration_ms_milliseconds_bucket{provider="bodhan"}[5m])))
//   sum by (outcome) (increase(pp_stt_request_duration_ms_milliseconds_count{provider="bodhan"}[1h]))
// Loki: {service_name="pp-sketch"} |~ "Bodhan"

// Dashboard: src/docs/grafana/pp-stt-dashboard.json (uid pp-stt) — import in Grafana Cloud
// (Dashboards → New → Import → paste JSON). Panels: Bodhan success rate + call count (1h),
// outcomes/5m stacked, p50/p95/p99, per-engine undici p95 (api.bodhan.ai beside
// api.sarvam.ai / Azure speechtotext), and a Loki pane filtered on "Bodhan". The saved
// claude-debug-readonly token cannot create dashboards, hence the JSON lives here.
