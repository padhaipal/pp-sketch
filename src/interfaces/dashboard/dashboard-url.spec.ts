import {
  assertDashboardEnv,
  dashboardPublicUrl,
  referralUrl,
  staffDashboardLink,
} from './dashboard-url';

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.DASHBOARD_PUBLIC_URL;
  process.env.DASHBOARD_PUBLIC_URL = 'https://dashboard.lifteracy.ai/';
});
afterEach(() => {
  if (saved === undefined) delete process.env.DASHBOARD_PUBLIC_URL;
  else process.env.DASHBOARD_PUBLIC_URL = saved;
});

describe('dashboard-url', () => {
  it('strips trailing slashes and builds the referral and staff links', () => {
    expect(dashboardPublicUrl()).toBe('https://dashboard.lifteracy.ai');
    expect(referralUrl('919999990001')).toBe(
      'https://dashboard.lifteracy.ai/r/919999990001',
    );
    expect(staffDashboardLink('u-1')).toBe(
      'https://dashboard.lifteracy.ai/d/u-1',
    );
    expect(() => assertDashboardEnv()).not.toThrow();
  });

  it('throws when unset or not an origin', () => {
    delete process.env.DASHBOARD_PUBLIC_URL;
    expect(() => referralUrl('x')).toThrow(/DASHBOARD_PUBLIC_URL must be set/);
    process.env.DASHBOARD_PUBLIC_URL = 'dashboard.lifteracy.ai';
    expect(() => assertDashboardEnv()).toThrow(/DASHBOARD_PUBLIC_URL/);
  });
});
