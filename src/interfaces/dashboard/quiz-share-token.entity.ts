import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

@Unique('uq_quiz_share_tokens_session_id', ['session_id'])
@Entity('quiz_share_tokens')
export class QuizShareTokenEntity {
  @PrimaryColumn({ type: 'text' })
  token: string;

  @Index('idx_quiz_share_tokens_session_id')
  @Column({ type: 'uuid' })
  session_id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}