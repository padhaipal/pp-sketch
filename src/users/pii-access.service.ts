import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isUuid, type ViewerContext } from '../auth/viewer';

// country > state > district > block > school > teacher: the recursion above
// a school never needs more hops than this.
const MAX_HIERARCHY_DEPTH = 6;

// Who may see whose personal data (name, phone) in full, and who may play
// whose voice recordings.
//
// Names and phones (visibleTo / canSee): one hop up the hierarchy — a user's
// personal data is visible only to the account DIRECTLY above them, never two
// or more levels up.
//   country > state > district > block > school > teacher > student
//   • a student's parent is the teacher who referred them
//     (users.referrer_user_id), and that teacher must be assigned to a
//     SCHOOL geo entity — an official whose referrals landed on a block or
//     district account does not get the children's details;
//   • a staff user's parent is the geo entity above their own
//     (geo_entity.parent_id): the block official sees the teachers' phones,
//     the district official sees the block official's, and so on.
// Staff sessions (dev/admin) see everything; an anonymous viewer nothing.
// Everything else is masked (pii-mask.ts).
//
// Voice recordings (canHear): the whole chain above the student — their
// referring teacher and every account whose geo entity is an ancestor of
// that teacher's (the block, district, state and country officials over
// the school). Anyone else gets 403 from GET media-meta-data/:id/audio.
@Injectable()
export class PiiAccessService {
  constructor(private readonly dataSource: DataSource) {}

  // The subset of `userIds` the viewer may see unmasked.
  async visibleTo(
    viewer: ViewerContext,
    userIds: readonly string[],
  ): Promise<Set<string>> {
    if (viewer.kind === 'staff') return new Set(userIds);
    if (viewer.kind === 'anonymous') return new Set();
    // Only uuids can be bound to the uuid[] parameter below; anything else
    // cannot be a users.id and is simply not visible.
    const ids = [...new Set(userIds.filter(isUuid))];
    if (ids.length === 0) return new Set();
    const rows: { id: string }[] = await this.dataSource.query(
      `/* pii-access:visible */
       SELECT u.id
       FROM users u
       JOIN users v ON v.id = $1 AND v.deleted_at IS NULL
       LEFT JOIN geo_entity vg ON vg.id = v.geo_entity_id
       LEFT JOIN geo_entity ug ON ug.id = u.geo_entity_id
       WHERE u.id = ANY($2::uuid[])
         AND u.deleted_at IS NULL
         AND (
           (u.role = 'student' AND u.referrer_user_id = v.id AND vg.type = 'school')
           OR
           (u.role <> 'student' AND ug.parent_id IS NOT NULL AND ug.parent_id = v.geo_entity_id)
         )`,
      [viewer.id, ids],
    );
    return new Set(rows.map((r) => r.id));
  }

  async canSee(viewer: ViewerContext, userId: string | null): Promise<boolean> {
    if (viewer.kind === 'staff') return true;
    if (!userId) return false;
    return (await this.visibleTo(viewer, [userId])).has(userId);
  }

  // Whether the viewer may play `userId`'s voice recordings: their referring
  // teacher, or an account whose geo entity sits STRICTLY above the
  // teacher's in the hierarchy (a colleague at the same school does not).
  async canHear(
    viewer: ViewerContext,
    userId: string | null,
  ): Promise<boolean> {
    if (viewer.kind === 'staff') return true;
    if (viewer.kind === 'anonymous' || !userId || !isUuid(userId)) return false;
    const rows: unknown[] = await this.dataSource.query(
      `/* pii-access:audible */
       WITH RECURSIVE up AS (
         -- the referring teacher's own geo entity (depth 0), then each parent
         SELECT t.geo_entity_id AS id, 0 AS depth
         FROM users s
         JOIN users t ON t.id = s.referrer_user_id
         WHERE s.id = $2 AND s.deleted_at IS NULL
         UNION ALL
         SELECT g.parent_id, up.depth + 1
         FROM geo_entity g
         JOIN up ON g.id = up.id
         WHERE g.parent_id IS NOT NULL AND up.depth < $3
       )
       SELECT 1
       FROM users v
       JOIN users s ON s.id = $2 AND s.deleted_at IS NULL
       WHERE v.id = $1 AND v.deleted_at IS NULL
         AND (
           v.id = s.referrer_user_id
           OR v.geo_entity_id IN (SELECT id FROM up WHERE depth > 0)
         )
       LIMIT 1`,
      [viewer.id, userId, MAX_HIERARCHY_DEPTH],
    );
    return rows.length > 0;
  }
}
