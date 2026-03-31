// pp-sketch/src/literacy/literacy-lesson/literacy-lesson.dto.prompt.md

import { BadRequestException } from '@nestjs/common';
import { User } from '../../users/user.dto';
import { MediaMetaData } from '../../media-meta-data/media-meta-data.dto';

// --- Entity (matches pg literacy_lesson_states table). TypeORM entity: src/literacy/literacy-lesson/literacy-lesson-state.entity.ts ---
// Append-only: every interaction inserts a new row. Many rows per user.
// Index: CREATE INDEX idx_literacy_lesson_states_user_latest ON literacy_lesson_states (user_id, created_at DESC)

export interface LiteracyLessonState {
  id: string;                    // UUID PK
  user_id: string;               // FK -> users.id (NOT unique — many rows per user)
  user_message_id: string;      // FK -> media_metadata.id — the user's audio message that produced this state
  word: string;                  // the word the lesson was teaching (denormalized from snapshot.context.word)
  snapshot: object;              // JSONB, dehydrated XState snapshot
  created_at: Date;              // TIMESTAMPTZ, default now()
}

// --- ProcessAnswer options ---
// Called by the inbound processor at step 7.
// `transcripts` is optional: omitted when starting a new lesson after the previous one completed (isComplete === true).

export interface ProcessAnswerOptions {
  user: User;                    // trusted — service uses .id directly (no extra DB hit)
  transcripts?: MediaMetaData[]; // STT transcript entities from findTranscripts(). Optional — absent when starting a fresh lesson after completion.
  user_message_id: string;      // the audio mediaMetaData entity's id — written as FK on lesson state and score rows
}

// --- ProcessAnswer result ---

export interface ProcessAnswerResult {
  stateTransitionId: string;     // from snapshot.context.stateTransitionId — used to look up outbound media
  isComplete: boolean;           // true when the machine reaches the 'complete' final state (word lesson is done)
}

// --- Runtime validation ---

export function validateProcessAnswerOptions(options: unknown): ProcessAnswerOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('processAnswer() options must be an object');
  }
  const o = options as Record<string, unknown>;

  if (!o.user || typeof o.user !== 'object' || typeof (o.user as User).id !== 'string') {
    throw new BadRequestException('processAnswer() options.user must be a User object with a valid id');
  }

  if (o.transcripts !== undefined) {
    if (!Array.isArray(o.transcripts)) {
      throw new BadRequestException('processAnswer() options.transcripts must be an array of MediaMetaData entities');
    }
    for (const t of o.transcripts) {
      if (!t || typeof t !== 'object' || typeof (t as MediaMetaData).id !== 'string') {
        throw new BadRequestException('processAnswer() options.transcripts must contain MediaMetaData objects with a valid id');
      }
    }
  }

  if (typeof o.user_message_id !== 'string' || o.user_message_id.length === 0) {
    throw new BadRequestException('processAnswer() options.user_message_id is required and must be a non-empty string');
  }

  return {
    user: o.user as User,
    transcripts: o.transcripts as MediaMetaData[] | undefined,
    user_message_id: o.user_message_id as string,
  };
}
