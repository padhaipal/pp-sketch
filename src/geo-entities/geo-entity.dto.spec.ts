import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_ROLE_TITLE_BY_TYPE,
  DESCENDANTS_DEFAULT_LIMIT,
  DESCENDANTS_MAX_LIMIT,
  GEO_ENTITY_STATUSES,
  GEO_ENTITY_TYPES,
  MANAGEMENT_GROUPS,
  validateDescendantsLimit,
  validateGeoEntityId,
  validateGeoEntityType,
} from './geo-entity.dto';

describe('geo-entity enums', () => {
  it('mirror the migration enums exactly', () => {
    expect(GEO_ENTITY_TYPES).toEqual([
      'country',
      'state',
      'district',
      'block',
      'cluster',
      'school',
    ]);
    expect(GEO_ENTITY_STATUSES).toEqual([
      'operational',
      'closed',
      'permanently_closed',
      'merged',
      'sanctioned_not_operational',
      'dcf_not_received',
    ]);
    expect(MANAGEMENT_GROUPS).toEqual([
      'government',
      'government_aided',
      'private',
      'other',
    ]);
  });

  it('default role titles cover every seeded level and never cluster', () => {
    expect(DEFAULT_ROLE_TITLE_BY_TYPE).toEqual({
      school: 'Teacher',
      block: 'BEO',
      district: 'BSA',
      state: 'DGSE',
      country: 'Minister',
    });
  });
});

describe('validators', () => {
  it('validateGeoEntityType', () => {
    expect(validateGeoEntityType('school')).toBe('school');
    expect(() => validateGeoEntityType('village')).toThrow(BadRequestException);
    expect(() => validateGeoEntityType(undefined)).toThrow(BadRequestException);
  });

  it('validateGeoEntityId names the field', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(validateGeoEntityId(id)).toBe(id);
    expect(() => validateGeoEntityId('x', 'cursor')).toThrow(
      'cursor must be a uuid',
    );
  });

  it('validateDescendantsLimit defaults, bounds and parses', () => {
    expect(validateDescendantsLimit(undefined)).toBe(DESCENDANTS_DEFAULT_LIMIT);
    expect(validateDescendantsLimit('')).toBe(DESCENDANTS_DEFAULT_LIMIT);
    expect(validateDescendantsLimit('7')).toBe(7);
    expect(validateDescendantsLimit(String(DESCENDANTS_MAX_LIMIT))).toBe(
      DESCENDANTS_MAX_LIMIT,
    );
    for (const bad of ['0', '501', '1.5', 'x', {}]) {
      expect(() => validateDescendantsLimit(bad)).toThrow(BadRequestException);
    }
  });
});
