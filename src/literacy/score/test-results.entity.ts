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
import { GeoEntityEntity } from '../../geo-entities/geo-entity.entity';

// See CreateTestResults migration + test-results.service.prompt.md.

@Index('idx_test_results_student_student_created', ['student_id', 'created_at'])
@Index('UQ_test_results_student_computed_for', ['student_id', 'computed_for'], {
  unique: true,
})
@Entity('test_results_student')
export class TestResultStudentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  student_id: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student: UserEntity;

  // The referrer's geo entity at compute time (SET NULL, never CASCADE).
  @Column({ type: 'uuid', nullable: true })
  geo_entity_id: string | null;

  @ManyToOne(() => GeoEntityEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'geo_entity_id' })
  geo_entity: GeoEntityEntity | null;

  @Column({ type: 'date' })
  computed_for: string;

  @Column({ type: 'numeric', precision: 4, scale: 3, nullable: true })
  nipun_g2_score: string | null;
  @Column({ type: 'boolean', nullable: true })
  nipun_g2_passed: boolean | null;
  @Column({ type: 'integer', default: 0 })
  nipun_g2_attempts: number;

  @Column({ type: 'numeric', precision: 4, scale: 3, nullable: true })
  nipun_g3_score: string | null;
  @Column({ type: 'boolean', nullable: true })
  nipun_g3_passed: boolean | null;
  @Column({ type: 'integer', default: 0 })
  nipun_g3_attempts: number;

  @Column({ type: 'numeric', precision: 4, scale: 3, nullable: true })
  mpl_b_score: string | null;
  @Column({ type: 'boolean', nullable: true })
  mpl_b_passed: boolean | null;
  @Column({ type: 'integer', default: 0 })
  mpl_b_attempts: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

@Index('idx_test_results_geo_entity_geo_computed', [
  'geo_entity_id',
  'computed_for',
])
@Index(
  'UQ_test_results_geo_entity_computed_for',
  ['geo_entity_id', 'computed_for'],
  { unique: true },
)
@Entity('test_results_geo_entity')
export class TestResultGeoEntityEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  geo_entity_id: string;

  @ManyToOne(() => GeoEntityEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'geo_entity_id' })
  geo_entity: GeoEntityEntity;

  @Column({ type: 'date' })
  computed_for: string;

  @Column({ type: 'integer' })
  students_active: number;
  @Column({ type: 'integer' })
  students_scored: number;
  @Column({ type: 'integer' })
  students_unbanded: number;

  @Column({ type: 'integer', default: 0 })
  nipun_g2_n: number;
  @Column({ type: 'numeric', precision: 10, scale: 3, default: 0 })
  nipun_g2_sum: string;
  @Column({ type: 'numeric', precision: 12, scale: 4, default: 0 })
  nipun_g2_sumsq: string;
  @Column({ type: 'integer', default: 0 })
  nipun_g2_pass: number;
  @Column({ type: 'integer', array: true, default: () => "'{0,0,0,0,0}'" })
  nipun_g2_hist: number[];

  @Column({ type: 'integer', default: 0 })
  nipun_g3_n: number;
  @Column({ type: 'numeric', precision: 10, scale: 3, default: 0 })
  nipun_g3_sum: string;
  @Column({ type: 'numeric', precision: 12, scale: 4, default: 0 })
  nipun_g3_sumsq: string;
  @Column({ type: 'integer', default: 0 })
  nipun_g3_pass: number;
  @Column({ type: 'integer', array: true, default: () => "'{0,0,0,0,0}'" })
  nipun_g3_hist: number[];

  @Column({ type: 'integer', default: 0 })
  mpl_b_n: number;
  @Column({ type: 'numeric', precision: 10, scale: 3, default: 0 })
  mpl_b_sum: string;
  @Column({ type: 'numeric', precision: 12, scale: 4, default: 0 })
  mpl_b_sumsq: string;
  @Column({ type: 'integer', default: 0 })
  mpl_b_pass: number;
  @Column({
    type: 'integer',
    array: true,
    default: () => `'{${Array(21).fill(0).join(',')}}'`,
  })
  mpl_b_hist: number[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

@Index('idx_test_runs_status_started', ['status', 'started_at'])
@Entity('test_runs')
export class TestRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  started_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finished_at: Date | null;

  @Column({ type: 'boolean', default: false })
  full: boolean;

  @Column({ type: 'integer', default: 0 })
  students_candidates: number;
  @Column({ type: 'integer', default: 0 })
  students_scored: number;
  @Column({ type: 'integer', default: 0 })
  geo_rows: number;

  @Column({ type: 'text' })
  status: 'running' | 'ok' | 'failed';

  @Column({ type: 'text', nullable: true })
  error: string | null;
}
