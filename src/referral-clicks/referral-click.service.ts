import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  RecordReferralClickDto,
  ReferralClickSummary,
  ReferralClickSummaryRow,
  UnmatchedReferralClickRow,
} from './referral-click.dto';

@Injectable()
export class ReferralClickService {
  constructor(private readonly dataSource: DataSource) {}

  // One row per click. The referrer is resolved to a user here; the raw
  // segment is kept only when no user matches it.
  async recordClick(input: RecordReferralClickDto): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO referral_link_clicks
         (referrer_user_id, unmatched_referrer, visitor_hash)
       SELECT u.id, CASE WHEN u.id IS NULL THEN r.ext END, $2
         FROM (SELECT $1::text AS ext) r
         LEFT JOIN users u ON u.external_id = r.ext`,
      [input.referrer, input.visitor_hash],
    );
  }

  // Clicks per referrer since `since`, with distinct visitors and the
  // number of users that referrer brought in over the same period.
  async summary(since: Date): Promise<ReferralClickSummary> {
    const referrers: ReferralClickSummaryRow[] = await this.dataSource.query(
      `SELECT u.id AS user_id,
              u.name,
              u.external_id,
              count(*)::int AS clicks,
              count(DISTINCT c.visitor_hash)::int AS unique_visitors,
              (SELECT count(*)::int FROM users s
                WHERE s.referrer_user_id = u.id
                  AND s.created_at >= $1) AS signups
         FROM referral_link_clicks c
         JOIN users u ON u.id = c.referrer_user_id
        WHERE c.clicked_at >= $1
        GROUP BY u.id
        ORDER BY clicks DESC`,
      [since],
    );
    const unmatched: UnmatchedReferralClickRow[] = await this.dataSource.query(
      `SELECT unmatched_referrer AS referrer,
              count(*)::int AS clicks,
              count(DISTINCT visitor_hash)::int AS unique_visitors
         FROM referral_link_clicks
        WHERE referrer_user_id IS NULL
          AND unmatched_referrer IS NOT NULL
          AND clicked_at >= $1
        GROUP BY unmatched_referrer
        ORDER BY clicks DESC`,
      [since],
    );
    return { since: since.toISOString(), referrers, unmatched };
  }
}
