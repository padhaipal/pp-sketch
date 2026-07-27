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

  // For word lessons: the drilled word. For passage lessons: the joined
  // sentence text (kept for existing readers). Nullable since passage-based
  // lessons; a CHECK constraint guarantees word OR passage_id is present.
  @Column({ type: 'text', nullable: true })
  word: string | null;

  // FK → media_metadata.id of the reading-passage row (media_details.level
  // selected it). Null for word lessons and pre-passage rows.
  @Index('idx_literacy_lesson_states_passage_id')
  @Column({ type: 'uuid', nullable: true })
  passage_id: string | null;

  @ManyToOne(() => MediaMetaDataEntity)
  @JoinColumn({ name: 'passage_id' })
  passage: MediaMetaDataEntity;

  @Column({ type: 'text', nullable: true })
  answer: string | null;

  @Column({ type: 'boolean', nullable: true })
  answer_correct: boolean | null;

  @Column({ type: 'jsonb' })
  snapshot: Record<string, unknown>;

  // Difficulty cap this lesson was selected at. Nullable: historical rows and
  // in-flight lessons at deploy time are null and self-heal on the next fresh
  // selection (selectNextString reads the most recent non-null value).
  @Column({ type: 'smallint', nullable: true })
  level: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
