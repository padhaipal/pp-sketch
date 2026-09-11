import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { UserEntity } from '../users/user.entity';
import { MediaMetaDataEntity } from '../media-meta-data/media-meta-data.entity';

// Append-only: one row per onboarding turn, the newest row is the current
// state. user_message_id is UNIQUE so a BullMQ retry can roll back exactly
// the row its previous attempt wrote (OnboardingService.rollback).
@Index('idx_onboarding_states_user_id_created', ['user_id', 'created_at'])
@Entity('onboarding_states')
export class OnboardingStateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ type: 'uuid', unique: true })
  user_message_id: string;

  @ManyToOne(() => MediaMetaDataEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_message_id' })
  user_message: MediaMetaDataEntity;

  @Column({ type: 'jsonb' })
  snapshot: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
