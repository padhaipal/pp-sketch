// pp-sketch/src/interfaces/elevenlabs/outbound/outbound.dto.prompt.md

// --- ElevenLabs API authentication ---
// All requests use header: xi-api-key: ${ELEVENLABS_API_KEY}

// =====================================================================
// Text-to-Speech — POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
// =====================================================================

// --- Request ---

// Path parameter: voice_id (string) — from job payload or ELEVENLABS_VOICE_ID default.

// Query parameters (optional):
//   output_format — audio codec/quality, default 'mp3_44100_128'

TtsRequest — the JSON body sent to ElevenLabs TTS endpoint.
{
  text: string;                            // required — the content to synthesize
  model_id?: string;                       // default 'eleven_multilingual_v2'
  language_code?: string;                  // ISO 639-1, e.g. 'hi', 'en'
  voice_settings?: {
    stability?: number;                    // 0.0–1.0
    similarity_boost?: number;             // 0.0–1.0
    style?: number;                        // 0.0–1.0
    speed?: number;                        // 0.7–1.2
    use_speaker_boost?: boolean;
  };
  seed?: number;                           // deterministic output
  apply_text_normalization?: 'auto' | 'on' | 'off'; // default 'auto'
}

// --- Response ---

// 200: binary audio stream (application/octet-stream). NOT JSON.
// The response body IS the audio file — stream directly to S3.

// 422: JSON validation error.
TtsErrorResponse
{
  detail: {
    status: string;
    message: string;
  };
}
