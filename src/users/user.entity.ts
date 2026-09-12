import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { GeoEntityEntity } from '../geo-entities/geo-entity.entity';

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_users_external_id')
  @Column({ type: 'text', unique: true })
  external_id: string;

  @Column({ type: 'uuid', nullable: true })
  referrer_user_id: string | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'referrer_user_id' })
  referrer: UserEntity | null;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', nullable: true })
  password_hash: string | null;

  @Column({ type: 'text', nullable: true })
  role: string | null;

  // Parent onboarding (src/onboarding): written together when the
  // onboarding machine reaches `done`; null until then.
  @Column({ type: 'smallint', nullable: true })
  birth_year: number | null;

  @Column({ type: 'smallint', nullable: true })
  birth_month: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  recording_permissions_obtained_at: Date | null;

  // Staff accounts (education officials). SET NULL, never CASCADE: deleting
  // a school must not delete its teacher.
  @Index('idx_users_geo_entity_id')
  @Column({ type: 'uuid', nullable: true })
  geo_entity_id: string | null;

  @ManyToOne(() => GeoEntityEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'geo_entity_id' })
  geo_entity: GeoEntityEntity | null;

  @Column({ type: 'text', nullable: true })
  role_title: string | null;

  @Column({ type: 'text', nullable: true })
  avatar_seed: string | null;

  @Column({ type: 'text', nullable: true })
  spotlight_message: string | null;

  @Column({ type: 'text', nullable: true })
  staff_notes: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  deleted_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
