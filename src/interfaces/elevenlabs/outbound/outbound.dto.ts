export interface TtsVoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  speed?: number;
  use_speaker_boost?: boolean;
}

export interface TtsRequest {
  text: string;
  model_id?: string;
  language_code?: string;
  voice_settings?: TtsVoiceSettings;
  seed?: number;
  apply_text_normalization?: 'auto' | 'on' | 'off';
}

export interface TtsErrorResponse {
  detail: {
    status: string;
    message: string;
  };
}
