import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

@Unique('uq_mailing_list_entries_email', ['email'])
@Entity('mailing_list_entries')
export class MailingListEntryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  email: string;

  @Column({ type: 'text', nullable: true })
  name: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}