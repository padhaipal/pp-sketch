import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { UserEntity } from '../../users/user.entity';
import { MediaMetaDataEntity } from '../../media-meta-data/media-meta-data.entity';

@Index('idx_literacy_lesson_states_user_id_created', ['user_id', 'created_at'])
@Entity('literacy_lesson_states')
export class LiteracyLessonStateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ type: 'uuid' })
  user_message_id: string;

  @ManyToOne(() => MediaMetaDataEntity)
  @JoinColumn({ name: 'user_message_id' })
  user_message: MediaMetaDataEntity;

  @Column({ type: 'text' })
  word: string;

  @Column({ type: 'boolean', nullable: true })
  answer_correct: boolean | null;

  @Column({ type: 'jsonb' })
  snapshot: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
