# dashboard-url.ts — links into pp-dashboard

`DASHBOARD_PUBLIC_URL` (required env; `assertDashboardEnv()` runs in
src/main.ts bootstrap) is the one place the dashboard origin lives.
`dashboardPublicUrl()` validates it (http(s) origin) and strips trailing
slashes.

- `referralUrl(externalId)` → `${origin}/r/${externalId}` — the referral
  link sent to students (onboarding completion, morning update, report card).
- `staffDashboardLink(userId)` → `${origin}/d/${userId}` — the personal
  dashboard link handed to a staff account at creation (POST
  /users/staff-create and every staff read). The `/d/:id` route ships with
  Prompt C; until then the link is dead by design.

Never hardcode `https://dashboard.padhaipal.com` elsewhere.
