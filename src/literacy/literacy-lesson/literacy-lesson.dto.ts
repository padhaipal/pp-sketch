import { BadRequestException } from '@nestjs/common';
import { User } from '../../users/user.dto';
import { MediaMetaData } from '../../media-meta-data/media-meta-data.dto';

export interface LiteracyLessonState {
  id: string;
  user_id: string;
  user_message_id: string;
  word: string;
  answer_correct: boolean | null;
  snapshot: any;
  created_at: Date;
}

export interface ProcessAnswerOptions {
  user: User;
  transcripts?: MediaMetaData[];
  user_message_id: string;
}

export interface ProcessAnswerResult {
  stateTransitionId: string;
  isComplete: boolean;
}

export function validateProcessAnswerOptions(
  options: unknown,
): ProcessAnswerOptions {
  if (!options || typeof options !== 'object') {
    throw new BadRequestException(
      'processAnswer() options must be an object',
    );
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

  if (
    typeof o.user_message_id !== 'string' ||
    o.user_message_id.length === 0
  ) {
    throw new BadRequestException(
      'processAnswer() options.user_message_id is required and must be a non-empty string',
    );
  }

  return {
    user: o.user as User,
    transcripts: o.transcripts as MediaMetaData[] | undefined,
    user_message_id: o.user_message_id as string,
  };
}
