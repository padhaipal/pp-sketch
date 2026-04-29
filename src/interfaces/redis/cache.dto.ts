export const CACHE_TTL = {
  USER: 3600,
  MEDIA_BY_STATE_TRANSITION: 86400,
  // 7 days — TinyURL links don't expire, so a long TTL is fine; we just want
  // the cache to bound our exposure if one ever does.
  REFERRAL_SHORT_URL: 604800,
} as const;

export const CACHE_KEYS = {
  userById: (id: string) => `user:id:${id}`,
  userByExternalId: (externalId: string) => `user:ext:${externalId}`,
  mediaByStateTransitionId: (stateTransitionId: string) =>
    `media:stid:${stateTransitionId}`,
  referralShortUrl: (externalId: string) => `referral:short:${externalId}`,
} as const;
