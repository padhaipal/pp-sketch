import { BadRequestException } from '@nestjs/common';

// Local check rather than the uuid package: this module is imported by the
// entity (and so by every entity-importing spec), and uuid is ESM-only under
// jest without a per-spec mock.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export const GEO_ENTITY_TYPES = [
  'country',
  'state',
  'district',
  'block',
  'cluster',
  'school',
] as const;
export type GeoEntityType = (typeof GEO_ENTITY_TYPES)[number];

export const GEO_ENTITY_STATUSES = [
  'operational',
  'closed',
  'permanently_closed',
  'merged',
  'sanctioned_not_operational',
  'dcf_not_received',
] as const;
export type GeoEntityStatus = (typeof GEO_ENTITY_STATUSES)[number];

export const MANAGEMENT_GROUPS = [
  'government',
  'government_aided',
  'private',
  'other',
] as const;
export type ManagementGroup = (typeof MANAGEMENT_GROUPS)[number];

// Default role title for a staff account attached to an entity of each type
// (POST /users/staff-create; the /onboarding form prefills from the same map).
// No cluster entry: cluster rows are never seeded.
export const DEFAULT_ROLE_TITLE_BY_TYPE: Partial<
  Record<GeoEntityType, string>
> = {
  school: 'Teacher',
  block: 'BEO',
  district: 'BSA',
  state: 'DGSE',
  country: 'Minister',
};

export interface GeoEntity {
  id: string;
  type: GeoEntityType;
  parent_id: string | null;
  code: string;
  name: string;
  lgd_code: string | null;
  lat: number | null;
  lng: number | null;
  has_boundary: boolean;
  status: GeoEntityStatus;
  merged_into_id: string | null;
  management_group: ManagementGroup | null;
  class_from: number | null;
  class_to: number | null;
  attributes: Record<string, unknown>;
  source: string;
  source_pulled_at: Date;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

// GET /geo-entities/search row.
export interface GeoEntitySearchRow {
  id: string;
  type: GeoEntityType;
  code: string;
  name: string;
  status: GeoEntityStatus;
  parent_name: string | null;
}

// GET /geo-entities/:id/descendants item.
export interface GeoEntityDescendantRow {
  id: string;
  code: string;
  name: string;
  has_boundary: boolean;
  lat: number | null;
  lng: number | null;
  status: GeoEntityStatus;
}

export interface DescendantsPage {
  items: GeoEntityDescendantRow[];
  next_cursor: string | null;
}

export const SEARCH_LIMIT = 20;
export const DESCENDANTS_MAX_LIMIT = 500;
export const DESCENDANTS_DEFAULT_LIMIT = 100;

// One row written by the seed (GeoEntityService.upsertBatch). Everything the
// table stores except the generated id / timestamps.
export interface GeoEntityUpsertRow {
  type: GeoEntityType;
  parent_id: string | null;
  code: string;
  name: string;
  lgd_code: string | null;
  lat: number | null;
  lng: number | null;
  has_boundary: boolean;
  status: GeoEntityStatus;
  management_group: ManagementGroup | null;
  class_from: number | null;
  class_to: number | null;
  attributes: Record<string, unknown>;
  source: string;
  source_pulled_at: Date;
}

export function validateGeoEntityType(value: unknown): GeoEntityType {
  if (
    typeof value !== 'string' ||
    !(GEO_ENTITY_TYPES as readonly string[]).includes(value)
  ) {
    throw new BadRequestException(
      `type must be one of: ${GEO_ENTITY_TYPES.join(', ')}`,
    );
  }
  return value as GeoEntityType;
}

export function validateGeoEntityId(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new BadRequestException(`${field} must be a uuid`);
  }
  return value;
}

export function validateDescendantsLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return DESCENDANTS_DEFAULT_LIMIT;
  }
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw.trim())
        ? Number(raw)
        : NaN;
  if (!Number.isInteger(n) || n < 1 || n > DESCENDANTS_MAX_LIMIT) {
    throw new BadRequestException(
      `limit must be an integer between 1 and ${DESCENDANTS_MAX_LIMIT}`,
    );
  }
  return n;
}
