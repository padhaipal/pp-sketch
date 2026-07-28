import { BadRequestException } from '@nestjs/common';
import { SnapshotFrom } from 'xstate';
import { User } from '../../users/user.dto';
import { MediaMetaData } from '../../media-meta-data/media-meta-data.dto';
import { machine } from './literacy-lesson.machine';

export type LessonSnapshot = SnapshotFrom<typeof machine>;

export interface LiteracyLessonState {
  id: string;
  user_id: string;
  user_message_id: string;
  word: string | null;
  answer: string | null;
  answer_correct: boolean | null;
  snapshot: LessonSnapshot;
  level: number | null;
  passage_id: string | null;
  created_at: Date;
}

export interface ProcessAnswerOptions {
  user: User;
  transcripts?: MediaMetaData[];
  user_message_id: string;
  // media_metadata id of the answer option the child tapped in the
  // comprehension WhatsApp Flow (from the nfm_reply). Mutually exclusive with
  // transcripts; only valid while the current lesson is awaiting a
  // comprehension answer. Staleness rules are bypassed for it — a flow tap
  // may legitimately arrive minutes after the flow was sent.
  comprehension_answer_id?: string;
}

export interface ProcessAnswerResult {
  stateTransitionIds: string[];
  isComplete: boolean;
  // Set when the next prompt for the student is a sentence (fresh sentence
  // lesson or a retry after a word drill). Sentences are generated at
  // runtime, so unlike words their text cannot come from pre-generated
  // media_metadata rows — the caller must render this as a text message.
  sentenceText?: string;
  // True when a comprehension answer arrived but the lesson was not awaiting
  // one (already answered, or no sentence lesson in flight). Nothing was
  // persisted; the caller should send nothing.
  ignored?: boolean;
}

export function validateProcessAnswerOptions(
  options: unknown,
): ProcessAnswerOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException('processAnswer() options must be an object');
  }
  const o = options as Record<string, unknown>;

  if (
    !o.user ||
    typeof o.user !== 'object' ||
    typeof (o.user as User).id !== 'string'
  ) {
    throw new BadRequestException(
      'processAnswer() options.user must be a User object with a valid id',
    );
  }

  if (o.transcripts !== undefined) {
    if (!Array.isArray(o.transcripts)) {
      throw new BadRequestException(
        'processAnswer() options.transcripts must be an array of MediaMetaData entities',
      );
    }
    for (const t of o.transcripts) {
      if (
        !t ||
        typeof t !== 'object' ||
        typeof (t as MediaMetaData).id !== 'string'
      ) {
        throw new BadRequestException(
          'processAnswer() options.transcripts must contain MediaMetaData objects with a valid id',
        );
      }
    }
  }

  if (typeof o.user_message_id !== 'string' || o.user_message_id.length === 0) {
    throw new BadRequestException(
      'processAnswer() options.user_message_id is required and must be a non-empty string',
    );
  }

  if (o.comprehension_answer_id !== undefined) {
    if (
      typeof o.comprehension_answer_id !== 'string' ||
      o.comprehension_answer_id.length === 0
    ) {
      throw new BadRequestException(
        'processAnswer() options.comprehension_answer_id must be a non-empty string',
      );
    }
    if (o.transcripts !== undefined) {
      throw new BadRequestException(
        'processAnswer() options.comprehension_answer_id and options.transcripts are mutually exclusive',
      );
    }
  }

  return {
    user: o.user as User,
    transcripts: o.transcripts as MediaMetaData[] | undefined,
    user_message_id: o.user_message_id,
    comprehension_answer_id: o.comprehension_answer_id,
  };
}
