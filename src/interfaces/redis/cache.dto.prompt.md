// pp-sketch/src/interfaces/redis/cache.dto.prompt.md

// Cache key conventions and TTL defaults for the pp-redis-cache instance.
// This Redis instance is SEPARATE from the BullMQ Redis instance used by queues.ts.
// Environment variable: CACHE_REDIS_URL (.env).

// --- TTL constants (seconds) ---

export const CACHE_TTL = {
  USER: 3600,                        // 1 hour — users rarely change (only phone number change system messages)
  MEDIA_BY_STATE_TRANSITION: 86400,  // 24 hours — lesson content is write-once-read-many; invalidated explicitly when WHATSAPP_PRELOAD completes
} as const;

// --- Key builders ---
// Every key is prefixed with the entity type to avoid collisions.
// Key patterns use ':' as separator.

export const CACHE_KEYS = {
  userById: (id: string) => `user:id:${id}`,
  userByExternalId: (externalId: string) => `user:ext:${externalId}`,
  mediaByStateTransitionId: (stateTransitionId: string) => `media:stid:${stateTransitionId}`,
} as const;

// --- Serialization ---
// All cached values are stored as JSON strings via JSON.stringify / JSON.parse.
// Date fields are serialized as ISO-8601 strings; the consumer must reconstruct Date objects if needed.
