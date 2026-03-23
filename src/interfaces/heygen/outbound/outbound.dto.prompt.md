// pp-sketch/src/interfaces/heygen/outbound/outbound.dto.prompt.md

// --- HeyGen API authentication ---
// All requests use header: X-Api-Key: ${HEYGEN_API_KEY}

// =====================================================================
// Video Generate — POST https://api.heygen.com/v2/video/generate
// =====================================================================

// --- Request ---

VideoGenerateRequest — the JSON body sent to HeyGen's video generate endpoint.
{
  video_inputs: VideoInput[];              // 1–50 scenes
  title?: string;                          // video title
  callback_id?: string;                    // set to media_metadata.id for webhook correlation
  callback_url?: string;                   // set to HEYGEN_CALLBACK_URL env var
  dimension?: { width: number; height: number }; // default 1920×1080
  caption?: boolean;                       // default false
}

VideoInput — one scene in the video.
{
  character: VideoCharacter;
  voice: VideoVoice;
  background?: VideoBackground;
}

VideoCharacter — the avatar speaking in the scene.
{
  type: 'avatar';                          // only 'avatar' type is used (not talking_photo)
  avatar_id: string;                       // from job payload or HEYGEN_AVATAR_ID default
  avatar_style?: 'normal' | 'circle' | 'closeUp'; // default 'normal'
  scale?: number;                          // 0.0–5.0, default 1
  offset?: { x: number; y: number };
  matting?: boolean;
}

VideoVoice — text-driven speech for the avatar.
{
  type: 'text';                            // only text-driven voice is used
  voice_id: string;                        // from job payload or HEYGEN_VOICE_ID default
  input_text: string;                      // the script
  speed?: number;                          // 0.5–1.5, default 1
  pitch?: number;                          // -50 to 50, default 0
  emotion?: 'Excited' | 'Friendly' | 'Serious' | 'Soothing' | 'Broadcaster';
  locale?: string;                         // e.g. 'en-US', 'en-IN'
}

VideoBackground — scene background (optional).
{
  type: 'color' | 'image' | 'video';
  value?: string;                          // hex color for 'color' type, e.g. '#FFFFFF'
  url?: string;                            // asset URL for 'image' or 'video' type
  fit?: 'crop' | 'cover' | 'contain' | 'none'; // default 'cover'
}

// --- Response ---

VideoGenerateResponse — HeyGen's 200 response.
{
  error: null;
  data: {
    video_id: string;                      // unique ID for the generated video
  };
}

VideoGenerateErrorResponse — HeyGen's 4XX response.
{
  data: null;
  error: {
    code: string;                          // e.g. 'invalid_parameter'
    message: string;
  };
}

// =====================================================================
// Text-to-Speech (Starfish) — POST https://api.heygen.com/v1/audio/text_to_speech
// =====================================================================

// --- Request ---

TtsRequest — the JSON body sent to HeyGen's TTS endpoint.
{
  text: string;                            // 1–5000 characters
  voice_id: string;                        // from job payload or HEYGEN_VOICE_ID default
  input_type?: 'text' | 'ssml';           // default 'text'
  speed?: string;                          // '0.5'–'2.0' multiplier
  language?: string;                       // e.g. 'en', 'hi' — auto-detected if omitted
  locale?: string;                         // BCP-47 tag, e.g. 'en-IN', 'hi-IN'
}

// --- Response ---

TtsResponse — HeyGen's 200 response.
{
  error: null;
  data: {
    audio_url: string;                     // URL of the generated audio file (temporary — download promptly)
    duration: number;                      // audio duration in seconds
    request_id: string;                    // HeyGen's internal request ID
    word_timestamps?: WordTimestamp[];      // word-level timing data
  };
}

WordTimestamp
{
  word: string;
  start: number;                           // seconds
  end: number;                             // seconds
}

TtsErrorResponse — HeyGen's 4XX response.
{
  data: null;
  error: {
    code: string;
    message: string;
  };
}
