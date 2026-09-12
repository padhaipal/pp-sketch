# inbound.utils.ts — helpers for the wabot inbound processor

Stateless helpers lifted out of inbound.processor.ts so the processor reads
as the job's decision flow only. No Nest injection: every helper that needs
a service takes it as its first argument, the same way
`processWabotInboundJob` receives its dependencies. Logs under the
`WabotInboundProcessor` context so existing alerts and log searches keep
matching.

Layering: this file is wabot-transport code. Domain modules must not import
it — in particular nothing under src/onboarding may. Domain services return
state transition ids / text; the processor (via these helpers) turns them
into WhatsApp media.

## Outbound assembly

- `appendMediaItems(items, media, records?, stateTransitionId?)` — for one
  `FindMediaByStateTransitionIdResult`, push `OutboundMediaItem`s in the
  order video, audio, image, sticker, text (skipping absent types), then
  the flow LAST via `appendFlowItem`. Media items carry
  `mime_type` from `media_details.mime_type` (undefined when there is
  none); text items carry `body`. When `records` is given, each pushed
  entity is appended as `{media_metadata_id, state_transition_id}` for the
  outbound_messages audit row.
- `appendFlowItem(items, entity, records?, stateTransitionId?)` — builds
  the comprehension flow item from a `media_type='flow'` row: parses the
  stored `FlowMediaPayload`, shuffles the options (fresh order every send),
  titles them A–D, caps descriptions at 300 chars (Meta limit), wraps them
  with the static body/CTA copy and `COMPREHENSION_FLOW_SCREEN`, and uses
  `WHATSAPP_COMPREHENSION_FLOW_ID` (env) as the flow id. Missing env,
  unparseable or malformed payload (no question text, <2 or >4 options):
  log ERROR and skip the item — the rest of the bundle still goes out.
- `shuffled(items)` — Fisher–Yates copy; never mutates the input.

## Inbound parsing

- `parseNfmReplyAnswerId(interactive)` — extracts `answer_id` from an
  `nfm_reply`'s `response_json`. Device input: accept only a JSON object
  with a non-empty string `answer_id` ≤ 100 chars from a `response_json`
  ≤ 10 000 chars; anything else → null. Ownership validation is
  `literacyLessonService.processAnswer`'s job, not this parser's.

## Sending

- `handleSendResult(result, label)` — logs `${label} sendMessage 4XX: n`
  as ERROR, `5XX` as WARN, nothing otherwise. For sends whose failure must
  not fail the job (the processor's main reply send handles its own
  statuses and throws).
- `sendFallbackAndHandle(wabotOutbound, payload, ctx)` — sends the
  `FALL_BACK_MESSAGE_PUBLIC_URL` video to `payload.message.from` with
  `otel_carrier: injectCarrierFromContext(ctx)`. Any failure is WARN-logged
  and swallowed.
- `sendAudioOnlyRedirect(mediaMetaDataService, wabotOutbound, {user,
  payload, ctx})` — the "please send a voice note" reply for non-audio
  messages. Looks up `AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID`; a missing
  video row is a config/data bug: log ERROR and THROW (fails the job so it
  alerts; the user still gets wabot's timeout fallback). Send failures and
  non-2XX statuses are logged (`handleSendResult(…, 'audio-only')`) and
  swallowed.

## Voice-note ingestion

- `persistAndTranscribeAudio(mediaMetaDataService, {payload, user, span})
  → {audioEntity, transcripts}` — steps 6 and 7 of the processor:
  `createWhatsappAudioMedia({wa_media_url, user, otel_carrier:
  injectCarrier(span)})` (idempotent by `wa_media_url`, so BullMQ retries
  reuse the same entity id), then `rearmHailMary` for the user (best
  effort: a failure is WARN-logged and ignored), then
  `findTranscripts({media_metadata: audioEntity})`. Zero transcripts: log
  ERROR and throw `No transcripts` — the job cannot proceed. Does NOT run
  `cleanupPartialState`; the processor does that after this returns and
  before `processAnswer`.
