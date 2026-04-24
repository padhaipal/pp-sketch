import { createHmac } from 'node:crypto';

const HMAC_KEY_ENV = 'LOG_PII_HMAC_KEY';

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const value = process.env[HMAC_KEY_ENV];
  if (!value) {
    throw new Error(`${HMAC_KEY_ENV} environment variable is required.`);
  }
  const key = Buffer.from(value, 'hex');
  if (key.length < 32) {
    throw new Error(
      `${HMAC_KEY_ENV} must be a hex-encoded key of at least 32 bytes (64 hex chars).`,
    );
  }
  cachedKey = key;
  return cachedKey;
}

// HMAC-SHA256 of a phone number, truncated to 10 hex chars (40 bits).
// Same input always maps to the same token within a deployment, so cross-log
// correlation works. Irreversible without the HMAC key.
// Must share LOG_PII_HMAC_KEY with wabot-sketch so hashes match across services.
export function toLogId(phone: string): string {
  const digest = createHmac('sha256', getKey()).update(phone).digest('hex');
  return `u_${digest.slice(0, 10)}`;
}
