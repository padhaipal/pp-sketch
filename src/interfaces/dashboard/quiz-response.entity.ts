import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

@Unique('uq_quiz_responses_session_question', ['session_id', 'question_index'])
@Entity('quiz_responses')
export class QuizResponseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_quiz_responses_session_id')
  @Column({ type: 'uuid' })
  session_id: string;

  @Column({ type: 'int' })
  question_index: number;

  @Column({ type: 'double precision' })
  answer: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}