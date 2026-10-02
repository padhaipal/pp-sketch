import { BadRequestException } from '@nestjs/common';
import {
  ANONYMOUS,
  assertUuidUnlessStaff,
  isUuid,
  STAFF,
  viewerFromRequest,
} from './viewer';

const UUID = '5c2a6f0e-1a2b-4c3d-9e8f-0a1b2c3d4e5f';
const req = (
  apiCaller: 'dashboard' | 'wabot' | undefined,
  headers: Record<string, string>,
) => ({
  apiCaller,
  header: (n: string) => headers[n],
});

describe('viewerFromRequest', () => {
  it('is anonymous unless the badge is the dashboard’s, whatever the headers say', () => {
    for (const caller of ['wabot', undefined] as const) {
      expect(viewerFromRequest(req(caller, { 'x-pp-viewer-staff': '1' }))).toBe(
        ANONYMOUS,
      );
      expect(viewerFromRequest(req(caller, { 'x-pp-viewer-id': UUID }))).toBe(
        ANONYMOUS,
      );
    }
  });

  it('staff header wins over a viewer id', () => {
    expect(
      viewerFromRequest(
        req('dashboard', { 'x-pp-viewer-staff': '1', 'x-pp-viewer-id': UUID }),
      ),
    ).toBe(STAFF);
    // only the literal "1" means staff
    expect(
      viewerFromRequest(req('dashboard', { 'x-pp-viewer-staff': 'true' })),
    ).toBe(ANONYMOUS);
  });

  it('a uuid viewer id (any case) identifies a link holder; anything else is anonymous', () => {
    expect(
      viewerFromRequest(
        req('dashboard', { 'x-pp-viewer-id': UUID.toUpperCase() }),
      ),
    ).toEqual({
      kind: 'user',
      id: UUID,
    });
    for (const bad of ['919876543210', 'abc', '']) {
      expect(
        viewerFromRequest(req('dashboard', { 'x-pp-viewer-id': bad })),
      ).toBe(ANONYMOUS);
    }
    expect(viewerFromRequest(req('dashboard', {}))).toBe(ANONYMOUS);
  });
});

describe('assertUuidUnlessStaff', () => {
  it('staff may pass any id; others only a uuid', () => {
    expect(() => assertUuidUnlessStaff(STAFF, '919876543210')).not.toThrow();
    expect(() => assertUuidUnlessStaff(ANONYMOUS, UUID)).not.toThrow();
    expect(() =>
      assertUuidUnlessStaff({ kind: 'user', id: UUID }, UUID),
    ).not.toThrow();
    expect(() => assertUuidUnlessStaff(ANONYMOUS, '919876543210')).toThrow(
      BadRequestException,
    );
    expect(() =>
      assertUuidUnlessStaff({ kind: 'user', id: UUID }, 'abc'),
    ).toThrow(/id must be a uuid/);
  });
  it('isUuid', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(`${UUID}-`)).toBe(false);
  });
});
