import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

// The UNIQUE constraint on session_id is backed by a btree index that already
// serves all WHERE session_id = $1 lookups; no separate @Index needed.
@Unique('uq_quiz_share_tokens_session_id', ['session_id'])
@Entity('quiz_share_tokens')
export class QuizShareTokenEntity {
  @PrimaryColumn({ type: 'text' })
  token: string;

  @Column({ type: 'uuid' })
  session_id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}