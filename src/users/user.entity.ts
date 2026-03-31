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

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
