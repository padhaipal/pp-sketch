export const CACHE_TTL = {
  USER: 3600,
  MEDIA_BY_STATE_TRANSITION: 86400,
} as const;

export const CACHE_KEYS = {
  userById: (id: string) => `user:id:${id}`,
  userByExternalId: (externalId: string) => `user:ext:${externalId}`,
  mediaByStateTransitionId: (stateTransitionId: string) =>
    `media:stid:${stateTransitionId}`,
} as const;
