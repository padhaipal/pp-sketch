import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { MediaMetaDataEntity } from '../../media-meta-data/media-meta-data.entity';

@Entity('letters')
export class LetterEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_letters_grapheme')
  @Column({ type: 'text', unique: true })
  grapheme: string;

  @Column({ type: 'uuid', nullable: true })
  media_metadata_id: string | null;

  @ManyToOne(() => MediaMetaDataEntity, { nullable: true })
  @JoinColumn({ name: 'media_metadata_id' })
  media_metadata: MediaMetaDataEntity | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
