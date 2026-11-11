import { IsString, Matches } from 'class-validator';

// Body of POST /referral-clicks, sent by the dashboard's /r/<phone> redirect.
export class RecordReferralClickDto {
  // The /r/<segment> path segment: the referrer's external_id (phone digits
  // with country code). The redirect already caps it at 15 characters.
  @IsString()
  @Matches(/^\d{6,15}$/)
  referrer: string;

  // Hex HMAC-SHA256 of (IST day, IP, user agent), computed by the dashboard.
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  visitor_hash: string;
}

export interface ReferralClickSummaryRow {
  user_id: string;
  name: string | null;
  external_id: string;
  clicks: number;
  unique_visitors: number;
  signups: number;
}

export interface UnmatchedReferralClickRow {
  referrer: string;
  clicks: number;
  unique_visitors: number;
}

export interface ReferralClickSummary {
  since: string;
  referrers: ReferralClickSummaryRow[];
  unmatched: UnmatchedReferralClickRow[];
}
