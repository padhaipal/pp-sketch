import type { DataSource } from 'typeorm';

export interface ActiveUser {
  user_id: string;
  external_id: string;
  last_message_at: Date;
  last_message_id: string;
}

export interface GetActiveUsersOptions {
  windowStart: Date;
  idleSince: Date;
}

// Users who sent a WhatsApp message between windowStart and idleSince but
// not after idleSince. Shared by evening-reminder (idleSince = 5h-ish ago) and
// morning-update (idleSince = 5 min ago) — both want users active in the last
// 24h who are currently idle.
export async function getActiveUsers(
  dataSource: DataSource,
  options: GetActiveUsersOptions,
): Promise<ActiveUser[]> {
  return dataSource.query(
    `SELECT mm.user_id, u.external_id,
            MAX(mm.created_at) AS last_message_at,
            (SELECT m2.id FROM media_metadata m2
             WHERE m2.user_id = mm.user_id AND m2.source = 'whatsapp'
             ORDER BY m2.created_at DESC LIMIT 1) AS last_message_id
     FROM media_metadata mm
     JOIN users u ON u.id = mm.user_id
     WHERE mm.source = 'whatsapp'
       AND mm.user_id IS NOT NULL
       AND mm.created_at >= $1
     GROUP BY mm.user_id, u.external_id
     HAVING MAX(mm.created_at) < $2`,
    [options.windowStart, options.idleSince],
  );
}