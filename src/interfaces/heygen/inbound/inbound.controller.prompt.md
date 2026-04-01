// pp-sketch/src/interfaces/heygen/inbound/inbound.controller.prompt.md

// POST endpoint receiving HeyGen webhook callbacks.
// No authentication or authorization is required from dashboard callers;
// however HeyGen webhook requests are verified via HMAC-SHA256 signature.

// Environment variables:
//   HEYGEN_WEBHOOK_SECRET — the secret returned when the webhook endpoint was registered with HeyGen

// Swagger: @ApiTags('heygen-webhook')

receive()
1.) Extract the raw request body (prefer `req.rawBody` to preserve the exact bytes HeyGen signed; fall back to `req.body` only if rawBody is unavailable) and the `Signature` header.
2.) Verify the webhook signature:
  * Compute HMAC-SHA256 of the raw body using HEYGEN_WEBHOOK_SECRET. Encode the result as a hex string.
  * Compare using `crypto.timingSafeEqual(Buffer.from(computedHex), Buffer.from(signatureHeader))` — never use `===` for signature comparison as it is vulnerable to timing attacks. Ensure both buffers are the same length before comparing (unequal lengths indicate a mismatch — return 401 immediately without calling timingSafeEqual).
  * If they do not match: log WARN and return 401.
3.) Validate the parsed JSON body against src/interfaces/heygen/inbound/inbound.dto.ts (HeygenWebhookDto).
  * If validation fails: return 400.
4.) Start a root span: `startRootSpan('heygen-inbound-controller')` (no incoming OTel carrier — external webhook). See src/otel/otel.prompt.md for helpers.
5.) Enqueue a job on the HEYGEN_INBOUND BullMQ queue with payload: { event_type, event_data, otel_carrier: injectCarrier(span) }.
  * If enqueue fails: log WARN and retry with exponential backoff (10s time cap).
    * If time cap is reached: log ERROR, end span, return 500.
6.) Return 200 and end the span.
