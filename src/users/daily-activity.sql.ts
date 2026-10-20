import { ACTIVITY_EVENT_SQL, COUNTED_GAP_SQL, IS_TAP_SQL } from './active-time';

export const FIVE_MIN_MS = 5 * 60 * 1000;
// SQL fragment: IST calendar date of a timestamptz. IST is a fixed +5:30 (no
// DST) so a plain interval add matches the JS helpers in report-card.utils.
export const IST_DATE_SQL = (col: string) =>
  `((${col} AT TIME ZONE 'UTC') + interval '330 minutes')::date`;

// CTEs ending in `per_user_day (user_id, ist_date, active_ms)`: every
// user's active ms per IST day by the active-time.ts gap rule (gap between
// consecutive activity events of the same user, both in the same IST day,
// shorter than the allowance of the event that ends it). Shared by the
// staff summary and the public traction series (traction.service.ts) so
// both count time the same way. Use after `WITH`.
export const PER_USER_DAY_ACTIVE_CTES = (): string => `msgs AS (
           SELECT user_id, created_at, ${IS_TAP_SQL()} AS is_tap,
                  LAG(created_at) OVER (
                    PARTITION BY user_id ORDER BY created_at
                  ) AS prev_created_at
           FROM media_metadata
           WHERE user_id IS NOT NULL
             AND ${ACTIVITY_EVENT_SQL()}
         ),
         gaps AS (
           SELECT user_id, is_tap,
                  ${IST_DATE_SQL('created_at')} AS ist_date,
                  ${IST_DATE_SQL('prev_created_at')} AS prev_ist_date,
                  EXTRACT(EPOCH FROM (created_at - prev_created_at)) * 1000
                    AS gap_ms
           FROM msgs
         ),
         per_user_day AS (
           SELECT user_id, ist_date,
                  COALESCE(SUM(gap_ms) FILTER (
                    WHERE ${COUNTED_GAP_SQL('gap_ms', 'is_tap')}
                      AND prev_ist_date = ist_date
                  ), 0) AS active_ms
           FROM gaps
           GROUP BY user_id, ist_date
         )`;
