export const CACHE_TTL = {
  USER: 3600,
  MEDIA_BY_STATE_TRANSITION: 86400,
  DASHBOARD_SUMMARY: 900,
  // keyed by the IST date it was computed on; a little over a day so the
  // key outlives its date even if the warm job runs late
  TRACTION: 26 * 3600,
  // the donor page polls every 60 s; one query per window for all visitors
  INTERACTION_STREAM: 45,
} as const;

export const CACHE_KEYS = {
  userById: (id: string) => `user:id:${id}`,
  userByExternalId: (externalId: string) => `user:ext:${externalId}`,
  mediaByStateTransitionId: (stateTransitionId: string) =>
    `media:stid:${stateTransitionId}`,
  dashboardSummary: () => `dashboard:summary`,
  // public traction series (users/traction.service.ts), per IST date
  traction: (istDate: string) => `dashboard:traction:v2:${istDate}`,
  // public interaction stream (users/interaction-stream.service.ts)
  interactionStream: () => `dashboard:interactions:v1`,
} as const;
