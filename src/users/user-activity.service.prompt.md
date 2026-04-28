// pp-sketch/src/users/user-activity.service.prompt.md

UserActivityService — voice-message activity-time analytics over arbitrary
time windows. Backs `POST /users/activity-time` and is also called by the
report-card service for the 7-day bar chart.

## DB access pattern
Uses TypeORM Repository / QueryBuilder API only — no raw SQL. Does NOT write
to the DB.

## getActivityTime(request: ActivityTimeRequestDto): Promise<ActivityTimeResponse>

* Validate the body (class-validator on the DTO + structural checks).
* Resolve the user list: each `users[i]` is either a UUID or an E.164 phone
  number (sans +). UUIDs are matched on `users.id`, phone strings on
  `users.external_id`. Unknown users are silently dropped — they contribute
  no result rows. Order in the response mirrors first-mention order in the
  request, deduped by user id.
* Determine the earliest start and latest end across all windows.
* In a single round-trip, fetch all whatsapp voice messages
  (`source = 'whatsapp' AND media_type = 'audio' AND rolled_back = false`)
  for the resolved user ids whose `created_at` is in
  `[earliestStart, latestEnd]`, ordered by `(user_id, created_at)`.
* For each user × window:
    - Filter that user's messages to those with
      `start <= created_at <= end` (boundaries inclusive).
    - Walk the filtered list in order. For each pair of consecutive
      timestamps, if the gap is in `(0, 60_000) ms`, add that gap to
      `active_ms`. Reset across messages that fall outside the window so
      gaps never bridge an exclusion.

Reject windows where `start > end` with `BadRequestException`. Empty user
result list returned without error if all inputs fail to resolve.

## Notes
* The 60-second threshold is exclusive (a 60.000-second gap does NOT count).
* The fetch is one query for *all* users + windows; bucketing happens in
  memory. Cheap enough for a few users × ≤ 10 windows; for very large fan-outs
  a per-user CTE would be more efficient — not needed today.