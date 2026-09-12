import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import {
  GEO_ENTITY_STATUSES,
  GEO_ENTITY_TYPES,
  MANAGEMENT_GROUPS,
} from './geo-entity.dto';
import type {
  GeoEntityStatus,
  GeoEntityType,
  ManagementGroup,
} from './geo-entity.dto';

// Administrative geography: country → state → district → block → school,
// parent-linked. Written only by the seed script (via GeoEntityService);
// read by the staff endpoints. Schema notes in geo-entity.dto.prompt.md.
@Index('idx_geo_entity_parent_id', ['parent_id'])
@Index('idx_geo_entity_type_status', ['type', 'status'])
@Index('idx_geo_entity_merged_into_id', ['merged_into_id'])
@Index('UQ_geo_entity_type_code', ['type', 'code'], { unique: true })
@Entity('geo_entity')
export class GeoEntityEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: GEO_ENTITY_TYPES, enumName: 'geo_entity_type' })
  type: GeoEntityType;

  @Column({ type: 'uuid', nullable: true })
  parent_id: string | null;

  @ManyToOne(() => GeoEntityEntity, { nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent: GeoEntityEntity | null;

  @Column({ type: 'text' })
  code: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  lgd_code: string | null;

  @Column({ type: 'double precision', nullable: true })
  lat: number | null;

  @Column({ type: 'double precision', nullable: true })
  lng: number | null;

  @Column({ type: 'boolean', default: false })
  has_boundary: boolean;

  @Column({
    type: 'enum',
    enum: GEO_ENTITY_STATUSES,
    enumName: 'geo_entity_status',
    default: 'operational',
  })
  status: GeoEntityStatus;

  @Column({ type: 'uuid', nullable: true })
  merged_into_id: string | null;

  @ManyToOne(() => GeoEntityEntity, { nullable: true })
  @JoinColumn({ name: 'merged_into_id' })
  merged_into: GeoEntityEntity | null;

  @Column({
    type: 'enum',
    enum: MANAGEMENT_GROUPS,
    enumName: 'management_group',
    nullable: true,
  })
  management_group: ManagementGroup | null;

  @Column({ type: 'smallint', nullable: true })
  class_from: number | null;

  @Column({ type: 'smallint', nullable: true })
  class_to: number | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  attributes: Record<string, unknown>;

  @Column({ type: 'text' })
  source: string;

  @Column({ type: 'timestamptz' })
  source_pulled_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deleted_at: Date | null;
}
