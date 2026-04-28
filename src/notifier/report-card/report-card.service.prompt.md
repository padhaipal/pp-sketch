// pp-sketch/src/notifier/report-card/report-card.service.prompt.md

Generates the morning-update report card. Pure data-fetch + SHARP/SVG render
pipeline so it can be exercised both by the BullMQ send worker AND the
swagger-UI preview controller.

## Inputs

`generatePng(userIdOrExternal, options?)` — userIdOrExternal may be the user
UUID or external_id (E.164 phone w/o +). `options.now` lets tests pin "today".

## Data assembled (`buildData`)

* User (resolve via `UserService.find`).
* Letters learnt as of `today_IST_midnight` — call
  `ScoreService.getLettersLearnt(userId, { asOf: todayMid })`. This is the
  set displayed on the card. "Not this morning" → cut-off is *today's* IST
  midnight, so anything earned during today's IST date is excluded.
* Letters learnt as of `yesterday_IST_midnight` — same call with
  `asOf: yesterdayMid`. The delta is `letters_learnt_yesterday`, which the
  renderer highlights.
* 7-day activity windows. Build `windows[i] = { start: weekAgoMid + i*24h,
  end: + 24h }`. Call `UserActivityService.getActivityTime` once with all
  seven windows. Map to `DailyBar { date_iso, day_index, active_ms }` where
  `day_index` is the JS weekday (0=Sun..6=Sat) of the IST date.

The 7 IST days are oldest-first (so the rightmost bar is yesterday).

## Render pipeline

`buildReportCardSvg(data)` (in `report-card.svg.ts`) builds a 1080×1350 SVG:
* Title: `तुम्हारा रिपोर्ट कार्ड!` (top-left).
* Logo (top-right): inner content of `src/assets/branding/padhaipal-logo.svg`,
  loaded once and cached.
* Letter grid: 8-column grid of all letters learnt; highlighted letters are
  drawn on a `BRAND_BLUE_HEX` (#1D9EDF) circle with white fill. If
  `letters_learnt` is empty, an em-dash placeholder renders.
* Activity chart: 7 bars; height ∝ active_ms scaled so 5 min is always
  visible. Bars < 5 min are red (#E0454C), ≥ 5 min are brand blue.
  Unmarked dotted line at the 5-minute height (stroke-dasharray). Hindi
  weekday labels under each bar (`HINDI_WEEKDAY_SHORT`). Zero-activity bars
  render a thin grey baseline tick so the day still reads as "present".
* QR + CTA: brand-blue Hindi text `पढ़ाईपाल अभी आज़माएं!` next to a QR code
  encoding `https://wa.me/918528097842?text=…<phonenumber>…` per the spec.
  Generated each call (not cached) via the `qrcode` lib.

`generatePng()` runs `sharp(Buffer.from(svg)).png().toBuffer()`. Hindi
rendering relies on a Devanagari font being available system-wide (e.g.
Noto Sans Devanagari) — same constraint as any other librsvg-based SVG→raster
pipeline.

## findExistingForUser(userId, since)

Used by the morning-update send worker to detect a previously-rendered
report card for today. Filters `media_metadata` to:
  - `source = 'morning-update'`
  - `media_type = 'image'`
  - `user_id = $1`
  - `rolled_back = false`
  - `created_at >= since`
Returns the most recent matching row or null.

## Asset path

`src/assets/branding/padhaipal-logo.svg` is the canonical location.
`nest-cli.json` copies the entire `src/assets/**` tree into `dist/assets/`,
so `path.resolve(__dirname, '../../assets/branding/padhaipal-logo.svg')`
works in both dev (ts-node from src/) and prod (compiled to dist/).