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
import { LetterEntity } from '../letters/letter.entity';
import { MediaMetaDataEntity } from '../../media-meta-data/media-meta-data.entity';

@Entity('scores')
export class ScoreEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_scores_user_id')
  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Index('idx_scores_letter_id')
  @Column({ type: 'uuid' })
  letter_id: string;

  @ManyToOne(() => LetterEntity)
  @JoinColumn({ name: 'letter_id' })
  letter: LetterEntity;

  @Index('idx_scores_user_message_id')
  @Column({ type: 'uuid', nullable: true })
  user_message_id: string | null;

  @ManyToOne(() => MediaMetaDataEntity)
  @JoinColumn({ name: 'user_message_id' })
  user_message: MediaMetaDataEntity;

  @Column({ type: 'double precision' })
  score: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
