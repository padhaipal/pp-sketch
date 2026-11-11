# referral-click.controller.ts — /referral-clicks

Behind ApiKeyGuard with the dashboard key (wabot's key is scoped to
/wabot/inbound and cannot reach these).

- `POST /referral-clicks` — body `RecordReferralClickDto`; called by the
  dashboard's `/r/[externalId]` redirect for every non-bot tap. `{ ok: true }`.
- `GET /referral-clicks/summary?since=YYYY-MM-DD` — `since` is midnight IST
  of that day; anything else is a 400. Returns `ReferralClickSummary`.
