# referral-click.dto.ts

- `RecordReferralClickDto` — `referrer`: 6 to 15 digits (the /r/ segment,
  a phone number with country code); `visitor_hash`: 64 lowercase hex
  characters (HMAC-SHA256 computed by the dashboard, see its
  `src/app/r/[externalId]/route.ts`). The global ValidationPipe rejects
  anything else, including extra fields.
- `ReferralClickSummary` and its row types — the shape of
  `GET /referral-clicks/summary`.
