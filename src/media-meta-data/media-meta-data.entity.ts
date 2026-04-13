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
import type { MediaType, MediaSource, MediaStatus } from './media-meta-data.dto';

@Index('idx_media_metadata_content_hash_stid', ['content_hash', 'state_transition_id'], {
  where: '"content_hash" IS NOT NULL',
})
@Entity('media_metadata')
export class MediaMetaDataEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  media_type: MediaType;

  @Column({ type: 'text' })
  source: MediaSource;

  @Column({ type: 'text', default: 'created' })
  status: MediaStatus;

  @Index('idx_media_metadata_wa_media_url')
  @Column({ type: 'text', nullable: true })
  wa_media_url: string | null;

  @Column({ type: 'text', nullable: true })
  s3_key: string | null;

  @Column({ type: 'text', nullable: true })
  content_hash: string | null;

  @Index('idx_media_metadata_state_transition_id')
  @Column({ type: 'text', nullable: true })
  state_transition_id: string | null;

  @Column({ type: 'text', nullable: true })
  text: string | null;

  @Column({ type: 'jsonb', nullable: true })
  media_details: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  generation_request_json: Record<string, unknown> | null;

  @Index('idx_media_metadata_input_media_id')
  @Column({ type: 'uuid', nullable: true })
  input_media_id: string | null;

  @ManyToOne(() => MediaMetaDataEntity, { nullable: true })
  @JoinColumn({ name: 'input_media_id' })
  input_media: MediaMetaDataEntity | null;

  @Index('idx_media_metadata_user_id')
  @Column({ type: 'uuid', nullable: true })
  user_id: string | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity | null;

  @Column({ type: 'boolean', default: false })
  rolled_back: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
