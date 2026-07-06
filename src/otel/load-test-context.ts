import { context, propagation } from '@opentelemetry/api';
import type { OtelCarrier } from './otel.dto';
import { BAGGAGE_LOAD_TEST } from './baggage-keys';

// Reads the W3C Baggage `padhaipal.load_test` entry from a propagated
// OtelCarrier. Used by media-generation processors (HeyGen, ElevenLabs)
// that do not have a user_external_id in their job data but DO receive a
// carrier when enqueued. Returns true only if the entry is explicitly
// 'true'; missing carrier / missing baggage / missing entry / value
// 'false' all yield false so the real outbound API call proceeds. This
// matches the documented "let it pass if the user phone number isn't
// found" semantic — the guard is best-effort and never blocks real
// traffic when the load-test signal can't be determined.
export function isLoadTestCarrier(carrier: OtelCarrier | undefined): boolean {
  if (!carrier) return false;
  const ctx = propagation.extract(context.active(), carrier);
  const baggage = propagation.getBaggage(ctx);
  return baggage?.getEntry(BAGGAGE_LOAD_TEST)?.value === 'true';
}

// Prefix gate: is this external id (E.164 phone) a synthetic load-test user?
// Same predicate wabot applies to its outbound stubs. Lives here (not in
// stt/) because it gates any WhatsApp-boundary call, not just STT.
export function isLoadTestUser(userExternalId: string | undefined): boolean {
  const prefix = process.env.LOAD_TEST_PHONE_PREFIX;
  if (!prefix || prefix.length === 0) return false;
  return (
    typeof userExternalId === 'string' && userExternalId.startsWith(prefix)
  );
}
