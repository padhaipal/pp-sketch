// Every link pp-sketch hands to a user that lands on pp-dashboard is built
// here from DASHBOARD_PUBLIC_URL (required env, validated at bootstrap) —
// one convention, not a hardcode beside an env var.

export function dashboardPublicUrl(): string {
  const raw = process.env.DASHBOARD_PUBLIC_URL;
  if (!raw || !/^https?:\/\/[^\s/]+/.test(raw)) {
    throw new Error(
      `DASHBOARD_PUBLIC_URL must be set to the dashboard origin, e.g. https://dashboard.padhaipal.com (got ${JSON.stringify(raw)})`,
    );
  }
  return raw.replace(/\/+$/, '');
}

// Tappable referral link sent to students (onboarding completion, morning
// update, report card).
export function referralUrl(externalId: string): string {
  return `${dashboardPublicUrl()}/r/${externalId}`;
}

// Personal dashboard link handed to a staff account at creation. The /d/:id
// route ships with Prompt C; until then the link is dead by design.
export function staffDashboardLink(userId: string): string {
  return `${dashboardPublicUrl()}/d/${userId}`;
}

export function assertDashboardEnv(): void {
  dashboardPublicUrl();
}
