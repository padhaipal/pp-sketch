# referral-click.module.ts

Provides `ReferralClickService` and mounts `ReferralClickController`. No
entity: the service writes and reads `referral_link_clicks` with raw SQL
(migration 1796000000000-CreateReferralLinkClicks). Imported by AppModule.
