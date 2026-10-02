import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './api-key.guard';

// Who is looking. The dashboard proxy forwards this on behalf of its users
// (a staff session, or the holder of a /d/<user_id> teacher-dashboard link);
// pp-sketch only believes the headers when the badge is the dashboard's.
//   staff     — a dev/admin session: sees everything unmasked
//   user      — a /d link holder: PiiAccessService decides what they see
//   anonymous — nobody identified: everything masked
export type ViewerContext =
  | { kind: 'staff' }
  | { kind: 'user'; id: string }
  | { kind: 'anonymous' };

export const VIEWER_ID_HEADER = 'x-pp-viewer-id';
export const VIEWER_STAFF_HEADER = 'x-pp-viewer-staff';

export const ANONYMOUS: ViewerContext = { kind: 'anonymous' };
export const STAFF: ViewerContext = { kind: 'staff' };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_RE.test(value);

export function viewerFromRequest(req: {
  apiCaller?: AuthenticatedRequest['apiCaller'];
  header(name: string): string | undefined;
}): ViewerContext {
  if (req.apiCaller !== 'dashboard') return ANONYMOUS;
  if (req.header(VIEWER_STAFF_HEADER) === '1') return STAFF;
  const id = req.header(VIEWER_ID_HEADER);
  if (id && isUuid(id)) return { kind: 'user', id: id.toLowerCase() };
  return ANONYMOUS;
}

export const Viewer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ViewerContext =>
    viewerFromRequest(ctx.switchToHttp().getRequest<AuthenticatedRequest>()),
);

// Public reads that also accept a phone number as the id would otherwise let
// a link holder learn whether a number belongs to a student (and read their
// data). Staff may still look up by phone.
export function assertUuidUnlessStaff(viewer: ViewerContext, id: string): void {
  if (viewer.kind !== 'staff' && !isUuid(id)) {
    throw new BadRequestException('id must be a uuid');
  }
}
