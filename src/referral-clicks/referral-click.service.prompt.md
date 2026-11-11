# referral-click.service.ts — taps on /r/<phone> referral links

Raw SQL over `DataSource`, like the rest of the repo.

- `recordClick({referrer, visitor_hash})` — one `INSERT … SELECT` per tap.
  The referrer segment is resolved to `users.id` by `external_id`; the raw
  segment goes into `unmatched_referrer` ONLY when no user matches, so a
  known teacher's phone number is never copied here and `DELETE FROM users`
  (CASCADE) removes all of that user's clicks.
- `summary(since)` — per matched referrer since `since`: `clicks`,
  `unique_visitors` (distinct `visitor_hash`; the hash includes the IST day,
  so one person on two days counts twice) and `signups` (users with
  `referrer_user_id` = that referrer created since `since`). Plus
  `unmatched` segments with their counts. Ordered by clicks, descending.
