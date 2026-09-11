import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';

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

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
