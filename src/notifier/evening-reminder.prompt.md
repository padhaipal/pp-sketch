// pp-sketch/src/notifier/evening-reminder.prompt.md

Evening notification system. Every day at 7 PM IST a cron job finds users whose most
recent message was between 19 and 24 hours ago (i.e. between yesterday 7 PM and today
midnight IST). Users who messaged more recently are skipped — their 24-hour window is
still wide open. For each qualifying user, the cron job:
  1. Picks a random notification video (evening_notification_message).
  2. Calls literacyLessonService.processAnswer() using the user's most recent
     media_metadata id as user_message_id. This detects the stale lesson and starts
     a fresh one, returning stateTransitionIds.
  3. Resolves those stateTransitionIds into media items via findMediaByStateTransitionId().
  4. Combines the notification video + lesson media into a single OutboundMediaItem[] array.
  5. Enqueues a rate-limited NOTIFIER_SEND job (2 msg/s) with the full media array,
     ordered by soonest-expiring 24-hour window.

## Architecture overview

Two new BullMQ queues in pp-sketch:

* NOTIFIER — a single repeatable job that fires at 7 PM IST daily (cron: `30 13 * * *` UTC).
  The processor queries the database then fans out into NOTIFIER_SEND jobs.
* NOTIFIER_SEND — one job per user. Rate-limited to 2 jobs/second via BullMQ `limiter`
  on the Worker. Each job calls the new wabot-sketch `POST /sendNotification` endpoint.

A new wabot-sketch endpoint `POST /sendNotification` sends a video message to a user
without requiring a wamid or inflight-key check (the 24-hour window is still relevant
but is NOT enforced by pp-sketch since all recipients messaged within the last 24 hours).
wabot-sketch handles WhatsApp error codes:
  - 130429 (rate limit hit): throw so BullMQ retries with exponential backoff, log WARN.
  - 131047 (outside 24-hour window): log ERROR, do NOT retry (return success to avoid
    infinite retries on a permanent failure).

## 1. pp-sketch queues (interfaces/redis/queues.ts)

Add two queue names:

* NOTIFIER: 'notifier'
  - DEFAULT_JOB_OPTIONS: attempts: 1, removeOnComplete: true, removeOnFail: { count: 500 }
  - Rationale: the cron trigger itself should not retry; if it fails we wait for the
    next daily run. Single attempt is sufficient.

* NOTIFIER_SEND: 'notifier-send'
  - DEFAULT_JOB_OPTIONS: attempts: 5, backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: true, removeOnFail: { count: 5000 }
  - Rationale: each send may hit WhatsApp rate-limit error 130429 which is retryable.
    5 attempts with exponential backoff from 3 s gives ~45 s total retry window.

## 2. pp-sketch notifier processor (notifier/evening-reminder.processor.ts)

### processNotifierCronJob(job, dataSource, literacyLessonService, mediaMetaDataService)

1.) Query distinct user_ids whose most recent message falls in the 19–24 hour window,
    including each user's most recent media_metadata id:

    SELECT mm.user_id, u.external_id, MAX(mm.created_at) AS last_message_at,
           (SELECT m2.id FROM media_metadata m2
            WHERE m2.user_id = mm.user_id AND m2.source = 'whatsapp'
            ORDER BY m2.created_at DESC LIMIT 1) AS last_message_id
    FROM media_metadata mm
    JOIN users u ON u.id = mm.user_id
    WHERE mm.source = 'whatsapp'
      AND mm.user_id IS NOT NULL
      AND mm.created_at >= <7 PM IST yesterday>   -- 24h ago (window start)
    GROUP BY mm.user_id, u.external_id
    HAVING MAX(mm.created_at) <= <12 AM IST today> -- 19h ago (window end)

    The HAVING clause ensures users who messaged more recently than 19 hours ago
    are excluded — their 24-hour window is still wide open.

    Compute both cutoffs in code using a shared helper `getISTTimeToday(hour)`
    that builds a UTC Date for a given IST hour on today's date.

2.) Query all notification video URLs:
    SELECT wa_media_url
    FROM media_metadata
    WHERE state_transition_id = 'evening_notification_message'
      AND media_type = 'video'
      AND status = 'ready'
      AND wa_media_url IS NOT NULL

    If zero rows returned, log ERROR and return early (no media to send).

3.) Sort users ascending by last_message_at (soonest-expiring 24-hour window first).

4.) For each user (in sorted order):
    a. Start with an OutboundMediaItem[] containing a randomly chosen notification video.
    b. Call literacyLessonService.processAnswer({ user, user_message_id: last_message_id })
       to trigger a fresh lesson. The user's last media_metadata id is reused as the
       user_message_id — this is the same pattern used when a lesson completes and a new
       one starts within a single inbound message.
    c. Resolve each returned stateTransitionId into media via
       mediaMetaDataService.findMediaByStateTransitionId() and append to the array.
    d. If processAnswer or media resolution fails, log WARN and fall back to sending
       the notification video only.
    e. Enqueue a NOTIFIER_SEND job with { user_external_id, media }.

### processNotifierSendJob(job, wabotOutbound)

1.) Extract { user_external_id, media } from job.data.
2.) Call wabot-sketch POST /sendNotification with: { user_external_id, media }.
3.) If the response indicates rate-limit (130429), throw to trigger BullMQ retry.
4.) If the response indicates 24-hour window expired (131047), log WARN in pp-sketch
    and return (do not throw — this user is permanently undeliverable this cycle).
5.) If response is success, return normally.

## 3. wabot-sketch new endpoint: POST /sendNotification

### Controller (interfaces/pp/inbound/inbound.controller.ts)

Add a new `@Post('sendNotification')` method to PpInboundController.
Validates body using a new SendNotificationDto:
  - user_external_id: string (required)
  - media: OutboundMediaItemDto[] (required, min 1)

No wamid field. No inflight/consecutive Redis key check.

### Service (interfaces/whatsapp/outbound/outbound.service.ts)

Add a new `sendNotification` function that:
1.) Builds the same WhatsApp Graph API payload as sendMessage but without
    any inflight key logic.
2.) Calls the Graph API.
3.) Parses the response. If the response body contains error.code:
    - 130429: return { status: 429, error_code: 130429 } so the controller can
      relay this to pp-sketch for retry.
    - 131047: log ERROR ("Message failed: outside 24-hour window for user {user_id}"),
      return { status: 403, error_code: 131047 }.
4.) On success return { status: 200, delivered: true }.

### DTO (interfaces/pp/inbound/inbound.dto.ts)

New class SendNotificationDto:
  - user_external_id: string @IsString
  - media: OutboundMediaItemDto[] @IsArray @ArrayMinSize(1) @ValidateNested

## 4. pp-sketch main.ts wiring

1.) Import processNotifierCronJob and processNotifierSendJob from evening-reminder.processor.
2.) Create the NOTIFIER worker: createWorker(QUEUE_NAMES.NOTIFIER, ...) passing dataSource,
    literacyLessonService, and mediaMetaDataService.
3.) Create the NOTIFIER_SEND worker: createWorker(QUEUE_NAMES.NOTIFIER_SEND, ...) passing
    wabotOutbound. Configure the worker with BullMQ limiter: { max: 2, duration: 1000 }
    to enforce 2 messages per second.
4.) Create the NOTIFIER queue with createQueue and add a repeatable job:
    queue.add('notifier-cron', {}, { repeat: { pattern: '30 13 * * *' } })
    (13:30 UTC = 19:00 IST).
5.) Add error/failed listeners matching existing pattern.

## 5. pp-sketch WabotOutboundService (interfaces/wabot/outbound/outbound.service.ts)

Add a `sendNotification` method that POSTs to `${baseUrl}/sendNotification` with:
  { user_external_id, media }
Returns { status, body } where body may contain error_code for pp-sketch to inspect.
