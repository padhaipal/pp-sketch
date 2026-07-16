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

// Audit log: one row per media item sent to a user. Content is reached via
// media_metadata_id (never duplicated here); `status` flips to 'rolled_back'
// atomically with media_metadata.rolled_back when a send's inflight window
// expires.
@Index('idx_outbound_messages_user_id_created', ['user_id', 'created_at'])
@Index('idx_outbound_messages_user_message_id', ['user_message_id'])
@Entity('outbound_messages')
export class OutboundMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  // The inbound message this send replied to; NULL for sends with no
  // triggering message.
  @Column({ type: 'uuid', nullable: true })
  user_message_id: string | null;

  @ManyToOne(() => MediaMetaDataEntity, { nullable: true })
  @JoinColumn({ name: 'user_message_id' })
  user_message: MediaMetaDataEntity | null;

  // Best-effort provenance — see OUTBOUND_TRIGGERS in outbound-message.dto.ts.
  @Column({ type: 'text', default: 'other' })
  trigger: string;

  @Column({ type: 'text', nullable: true })
  state_transition_id: string | null;

  @Column({ type: 'uuid' })
  media_metadata_id: string;

  @ManyToOne(() => MediaMetaDataEntity)
  @JoinColumn({ name: 'media_metadata_id' })
  media_metadata: MediaMetaDataEntity;

  @Column({ type: 'text', default: 'sent' })
  status: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
