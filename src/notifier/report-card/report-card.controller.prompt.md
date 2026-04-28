// pp-sketch/src/notifier/report-card/report-card.controller.prompt.md

Swagger preview endpoint for the morning-update report card.

`GET /report-card/:userIdOrPhone` — renders the card on-the-fly for the given
user. Accepts a UUID or E.164 phone (sans +). Returns `image/png` with
`Cache-Control: no-store`. Intended to be called from the pp-dashboard swagger
UI (which proxies to pp-sketch's swagger spec) so a developer can preview a
specific user's card without actually queueing the morning-update job.