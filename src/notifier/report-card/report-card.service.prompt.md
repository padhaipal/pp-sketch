// pp-sketch/src/notifier/report-card/report-card.service.prompt.md

Generates the morning-update report card (v2, 2026-10): one card about
YESTERDAY, Hindi only. Pure data-fetch + sharp/SVG render pipeline shared by
the BullMQ send worker and the swagger preview controller
(`GET /report-card/:userIdOrPhone`).

## Inputs

`generatePng(userIdOrExternal, options?)` — a user UUID or external_id
(E.164 phone without +). `options.now` pins "today" in tests; the 7 AM IST
cron runs at ≈ 01:30 UTC, so `istMidnightUtc(now)` is today's IST midnight
and the card covers the IST day before it.

## Data (`buildData` → `ReportCardData`)

Three reads in parallel, all for yesterday's IST window
[yesterdayMid, todayMid):
* `UserActivityService.getActivityTime` with that one window → `active_ms`,
  `minutes` (`minutesOf`: whole minutes, a little practice never shows 0)
  and `time_band` (`timeBand`: ≥ 5 min good, any practice ok, none poor —
  the same 5-minute mark as the dashboard).
* `report-card:levels` — the newest non-null `literacy_lesson_states.level`
  before todayMid and before yesterdayMid → `level_delta` (0 when either is
  unknown, e.g. the first lesson ever) and `level_band` (`levelBand`: up
  good, unchanged ok, down poor).
* `report-card:letters` — `scores` rows yesterday joined to `letters`
  (grapheme) and to the message that produced them (`rolled_back = false`;
  seed scores have no message and never count), top three by count →
  `top_letters`.
* `praise` — `pickPraise(time_band, userId, dayNumber)`: one of twenty
  Hindi lines per band (`PRAISE_LINES`), stable for a child within a day,
  varying across days and children.

## Render (`buildReportCardSvg`, report-card.svg.ts)

Portrait 1080 × 1350, SVG primitives only, Noto Sans Devanagari:
* Header in the TIME band's colour (`BAND_COLOR_HEX`): "कल" (no date), a
  large face (smile / flat / frown = good / ok / poor) and the praise line.
  A parent who reads nothing still gets it.
* Two tiles, each with a coloured left rail, an icon (clock; up / flat /
  down triangle), a big number + unit (मिनट / स्तर) and its own small face,
  each in its OWN band's colour — a good day on one and a poor day on the
  other still read.
* Up to three navy chips with the letters practised most. No logo, QR or
  referral link (removed 2026-10).

`generatePng()` runs `sharp(svg).png()`; Hindi needs a Devanagari font on
the host (fonts-noto-core in the Dockerfile).

## findExistingForUser(userId, since)

The send worker's "already rendered today" check: `media_metadata` with
`source = 'morning-update'`, `media_type = 'image'`, `rolled_back = false`,
`created_at >= since`, newest first.
