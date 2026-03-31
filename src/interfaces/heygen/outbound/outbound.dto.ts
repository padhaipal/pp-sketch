export interface VideoCharacter {
  type: 'avatar';
  avatar_id: string;
  avatar_style?: 'normal' | 'circle' | 'closeUp';
  scale?: number;
  offset?: { x: number; y: number };
  matting?: boolean;
}

export interface VideoVoice {
  type: 'text';
  voice_id: string;
  input_text: string;
  speed?: number;
  pitch?: number;
  emotion?:
    | 'Excited'
    | 'Friendly'
    | 'Serious'
    | 'Soothing'
    | 'Broadcaster';
  locale?: string;
}

export interface VideoBackground {
  type: 'color' | 'image' | 'video';
  value?: string;
  url?: string;
  fit?: 'crop' | 'cover' | 'contain' | 'none';
}

export interface VideoInput {
  character: VideoCharacter;
  voice: VideoVoice;
  background?: VideoBackground;
}

export interface VideoGenerateRequest {
  video_inputs: VideoInput[];
  title?: string;
  callback_id?: string;
  callback_url?: string;
  dimension?: { width: number; height: number };
  caption?: boolean;
}

export interface VideoGenerateResponse {
  error: null;
  data: { video_id: string };
}

export interface VideoGenerateErrorResponse {
  data: null;
  error: { code: string; message: string };
}

export interface TtsRequest {
  text: string;
  voice_id: string;
  input_type?: 'text' | 'ssml';
  speed?: string;
  language?: string;
  locale?: string;
}

export interface TtsResponse {
  error: null;
  data: {
    audio_url: string;
    duration: number;
    request_id: string;
    word_timestamps?: { word: string; start: number; end: number }[];
  };
}

export interface TtsErrorResponse {
  data: null;
  error: { code: string; message: string };
}
