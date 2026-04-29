// pp-sketch/src/notifier/morning-update.prompt.md

Morning report-card delivery. Daily at 7 AM IST a cron job picks active users
(messaged in the last 24 h, idle ≥ 5 min) and queues a per-user job that
renders a personalised report card image and sends it on WhatsApp.

The "active users" SQL is shared with evening-reminder via
`notifier/notifier.utils.ts` (`getActiveUsers`) — same query, different
idle thresholds (5 min here, ~5 h there).

## Architecture overview

Two new BullMQ queues:

* MORNING_UPDATE — single repeatable job at 01:30 UTC = 07:00 IST.
  - DEFAULT_JOB_OPTIONS: attempts: 1 (cron retries waste a day), removeOnComplete.
  - Processor queries DB, fans out into MORNING_UPDATE_SEND jobs.

* MORNING_UPDATE_SEND — one job per active user.
  - DEFAULT_JOB_OPTIONS: attempts: 60, backoff: { type: 'fixed', delay: 1000 }.
    The 1-second fixed backoff is the "requeue gap" the worker leans on while
    the report card image is still rendering / pre-loading to WhatsApp.
  - Worker concurrency: 4.

## 1. Cron processor — processMorningUpdateCronJob(job, dataSource, mediaMetaDataService)

1.) `getActiveUsers(dataSource, { windowStart: now - 24h, idleSince: now - 5min })`.
    Same helper used by evening-reminder.

2.) Resolve the morning-notification-message preloaded media via
    `mediaMetaDataService.findMediaByStateTransitionId('morning_notification_message')`.
    Prefer the `video` slot, fall back to the `image` slot. If neither exists,
    log ERROR and return.

3.) Build `introItems: OutboundMediaItem[]` with that single media item — the
    per-user report card image is appended later, by the send worker, once
    it's `ready`.

4.) For each active user enqueue MORNING_UPDATE_SEND with:
    `{ user_id, user_external_id, media: introItems, otel_carrier }`.

## 2. Send worker — processMorningUpdateSendJob(...)

Concurrency: 4. Looks up (or creates) a per-user report-card image, waits for
WhatsApp pre-load, then sends.

1.) Compute `today = istMidnightUtc(now)` (00:00 IST today). Look up the
    most recent `media_metadata` row with
    `source = 'morning-update' AND user_id = $1 AND media_type = 'image'
       AND rolled_back = false AND created_at >= today`.
    Done via `ReportCardService.findExistingForUser()`.

2.) If no row → render the report card via `ReportCardService.generatePng()`,
    persist it via `MediaMetaDataService.createRenderedImageMedia({
      buffer, mime_type: 'image/png', user_id, source: 'morning-update', otel_carrier
    })`. That helper uploads to S3 and enqueues the `whatsapp-preload` job
    so status will progress 'created' → 'queued' → 'ready' asynchronously.
    After creating, throw a `RequeueRequestedError` so BullMQ retries with the
    queue's fixed 1-s backoff.

3.) If row exists with `status === 'failed'` → log ERROR and return (no retry).

4.) If row exists with `status !== 'ready'` (still 'created' / 'queued') →
    throw a `RequeueRequestedError` to trigger the 1-s requeue.

5.) If row exists with `status === 'ready'` and `wa_media_url` is set →
    build `fullMedia` as `[...job.data.media, { type: 'image', url, mime_type: 'image/png' }, { type: 'text', body: buildReferralUrl(user_external_id) }]`
    and call `wabotOutbound.sendNotification({ user_external_id, media: fullMedia })`.
    The trailing text item is the same `https://wa.me/918528097842?text=…`
    URL the QR code on the report card encodes — sent as a follow-up so the
    user can tap it directly to share, without needing a second device to
    scan the QR.
    Error-code handling matches evening-reminder send:
      - 130429 (rate limit): throw to retry.
      - 131047 (24h window expired): WARN and return (permanent for this cycle).
      - other non-delivered: throw.

## 3. Wiring (src/main.ts)

* Cron worker: `createWorker(QUEUE_NAMES.MORNING_UPDATE, ...)` passing
  `dataSource` and `mediaMetaDataService`. Add a repeat job with
  `pattern: '30 1 * * *'` (01:30 UTC = 07:00 IST).
* Send worker: `new Worker<MorningUpdateSendJobData>(QUEUE_NAMES.MORNING_UPDATE_SEND,
  ..., { connection, concurrency: 4 })` passing `reportCardService`,
  `mediaMetaDataService`, `mediaRepo`, `wabotOutbound`. No rate limiter — this
  worker requeues itself heavily, so a limiter would compound the wait.

## 4. Edge cases handled inside the report-card pipeline

* User with 0 letters learnt yesterday → no highlights, grid renders normally.
* User with 0 activity all 7 days → bars all 0; baseline ticks still render.
* User joined < 7 days ago → missing days have 0 activity by construction.

These are unit-tested in `report-card/report-card.service.spec.ts` and the
underlying activity SQL is integration-tested in
`users/user-activity.service.spec.ts` (DB-gated by `TEST_DATABASE_URL`).