// pp-sketch/src/users/user-activity.service.prompt.md

UserActivityService — voice-message activity-time analytics over arbitrary
time windows. Backs `POST /users/activity-time` and is also called by the
report-card service for the 7-day bar chart.

## DB access pattern

Uses TypeORM Repository / QueryBuilder API only — no raw SQL. Does NOT write
to the DB.

## getActivityTime(request: ActivityTimeRequestDto): Promise<ActivityTimeResponse>

- Validate the body (class-validator on the DTO + structural checks).
- Resolve the user list: each `users[i]` is either a UUID or an E.164 phone
  number (sans +). UUIDs are matched on `users.id`, phone strings on
  `users.external_id`. Unknown users are silently dropped — they contribute
  no result rows. Order in the response mirrors first-mention order in the
  request, deduped by user id.
- Determine the earliest start and latest end across all windows.
- In a single round-trip, fetch all whatsapp voice messages
  (`source = 'whatsapp' AND media_type = 'audio' AND rolled_back = false`)
  for the resolved user ids whose `created_at` is in
  `[earliestStart, latestEnd]`, ordered by `(user_id, created_at)`.
- For each user × window:
  - Filter that user's messages to those with
    `start <= created_at <= end` (boundaries inclusive).
  - Walk the filtered list in order. For each pair of consecutive
    timestamps, if the gap is in `(0, 60_000) ms`, add that gap to
    `active_ms`. Reset across messages that fall outside the window so
    gaps never bridge an exclusion.

Reject windows where `start > end` with `BadRequestException`. Empty user
result list returned without error if all inputs fail to resolve.

## Notes

- The 60-second threshold is exclusive (a 60.000-second gap does NOT count).
- The fetch is one query for _all_ users + windows; bucketing happens in
  memory. Cheap enough for a few users × ≤ 10 windows; for very large fan-outs
  a per-user CTE would be more efficient — not needed today.

## getTodayActiveTime(user_id)

Called by the wabot inbound processor on every voice turn; feeds all usage
milestones (daily minutes, day streak, total hours) from ONE raw-SQL
aggregate over all the user's whatsapp voice messages: one row per active
IST day (same gap rule as the dashboard summary — consecutive messages in
the same IST day, `0 < gap < ACTIVE_GAP_THRESHOLD_MS`) plus the gap that
day's last message added.

- `withLatestTurn` / `withoutLatestTurn`: today's (IST) active ms including
  and excluding the most recent voice message.
- `totalWithLatestTurn` / `totalWithoutLatestTurn`: the same pair summed over
  every day — all active time counts, whatever that day totalled.
- `priorStreakDays`: consecutive IST days immediately before today with at
  least `STREAK_DAY_MIN_ACTIVE_MS` (5 min) each; today is not counted.

## 2026-09: flow taps are activity events (active-time.ts)

The active-time rule now lives ONLY in `users/active-time.ts` and every
reader goes through it — `activeMs(events)` in TS, and the SQL fragments
`ACTIVITY_EVENT_SQL` / `IS_TAP_SQL` / `COUNTED_GAP_SQL` for the two raw-SQL
aggregates here (dashboard summary, `getTodayActiveTime`), the nightly usage
metric and the usage backfill. This supersedes the voice-only wording above.

- Events = the student's WhatsApp voice notes AND comprehension flow taps
  (the `media_type = 'text'` row with `media_details.nfm_reply = true` the
  inbound processor anchors a tap to), `rolled_back = false`.
- A gap between two consecutive events counts when it is shorter than the
  allowance of the event that ENDS it: 120 s for a voice note
  (`ACTIVE_GAP_THRESHOLD_MS`), 298 s for a tap
  (`TAP_ACTIVE_GAP_THRESHOLD_MS` — the student was reading the passage and
  question inside the flow; same 4 min 58 s the lesson allows a passage read
  before it goes stale). Both strict.
- Why: a level 11–12 lesson is tap-only, so those students earned zero
  minutes, no milestones, no streaks and zero on the teacher dashboard's
  usage metric.
- `getActivityTime` fetches `{at, tap}` events (`fetchActivityEvents`);
  `getTodayActiveTime` is called on every lesson turn — voice note OR tap —
  and its "latest turn" is the latest event of either kind. Its only bound
  parameter is the user id (the allowances are inlined constants).
- An IGNORED tap (no lesson awaiting it) is rolled back by the processor and
  therefore never an event.
- Not retroactive for STORED figures: `test_results_student.usage_*` rows
  already written keep their voice-only minutes unless the backfill script is
  re-run. Views computed live from `media_metadata` (dashboard summary,
  `/users/:id/metrics`, milestone totals) include past taps from this deploy.
