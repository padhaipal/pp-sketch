// pp-sketch/src/notifier/notifier.utils.prompt.md

Shared helpers for the two daily notifier crons (evening-reminder and
morning-update). Single source of truth for the "active user" SQL so the two
crons can't drift apart on filter logic.

## getActiveUsers(dataSource, { windowStart, idleSince })

Returns users who:
* sent a WhatsApp message between `windowStart` and `idleSince` (inclusive of
  `windowStart`, strictly less than `idleSince` on the most recent message),
* have a non-null `user_id` on `media_metadata`,
* matched on `source = 'whatsapp'`.

Output rows are `ActiveUser`:
  - user_id, external_id, last_message_at, last_message_id (most recent
    media_metadata id for the user, used by evening-reminder to seed
    `processAnswer`).

The implementation is the same SQL evening-reminder used inline before the
extraction — a `GROUP BY user_id, external_id` with a `HAVING MAX(created_at) < idleSince`
filter, plus a correlated subquery for `last_message_id`.

Callers pick their own `windowStart` / `idleSince`. Evening-reminder keeps its
historical 24 h / ~5 h thresholds, morning-update uses 24 h / 5 min.