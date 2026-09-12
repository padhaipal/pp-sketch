import { Logger } from '@nestjs/common';
import type { Context, Span } from '@opentelemetry/api';
import { MessageJobDto } from './wabot-inbound.dto';
import type { User } from '../../../users/user.dto';
import { MediaMetaDataService } from '../../../media-meta-data/media-meta-data.service';
import type { MediaMetaData } from '../../../media-meta-data/media-meta-data.dto';
import { WabotOutboundService } from '../outbound/outbound.service';
import {
  COMPREHENSION_FLOW_SCREEN,
  OutboundMediaItem,
} from '../outbound/outbound.dto';
import type { FlowMediaPayload } from '../../../media-meta-data/llm-generate.dto';
import { injectCarrier, injectCarrierFromContext } from '../../../otel/otel';
import { toLogId } from '../../../otel/pii';
import { FindMediaByStateTransitionIdResult } from '../../../media-meta-data/media-meta-data.dto';
import { AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID } from '../../../literacy/literacy-lesson/literacy-lesson.machine';
import { rearmHailMary } from '../../../notifier/hail-mary.processor';
import type { OutboundSentItem } from '../../../outbound-messages/outbound-message.dto';

// Same logger context as the processor these helpers were lifted out of, so
// existing log-based alerts and searches keep matching.
const logger = new Logger('WabotInboundProcessor');

// Static copy for the flow message wrapper; the question itself renders
// inside the flow.
const FLOW_MESSAGE_BODY = 'सवाल का जवाब देने के लिए नीचे बटन दबाओ 👇';
const FLOW_MESSAGE_CTA = 'जवाब दें';
const FLOW_OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const;
// Meta cap on RadioButtonsGroup option descriptions (also enforced at
// creation time in llm-generate.dto.ts and at send time in wabot-sketch).
const FLOW_OPTION_DESCRIPTION_MAX = 300;

// Extracts the tapped option id from an nfm_reply. response_json comes from
// the user's device — parse defensively, accept only a modest-length string
// answer_id, and let processAnswer do the real ownership validation.
export function parseNfmReplyAnswerId(
  interactive?: { type: string; nfm_reply?: { response_json: string } } | null,
): string | null {
  const raw = interactive?.nfm_reply?.response_json;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 10_000) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const answerId = parsed?.answer_id;
    if (
      typeof answerId === 'string' &&
      answerId.length > 0 &&
      answerId.length <= 100
    ) {
      return answerId;
    }
  } catch {
    // fall through — unparseable device payload
  }
  return null;
}

export function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Builds the outbound flow item from a media_type='flow' row: parse the
// stored FlowMediaPayload, shuffle the options (fresh order every send) and
// assign the fixed A-D titles. Config/data problems log an error and skip
// the item — the rest of the bundle still goes out.
export function appendFlowItem(
  items: OutboundMediaItem[],
  entity: { id: string; text?: string | null },
  records?: OutboundSentItem[],
  stateTransitionId?: string,
): void {
  const flowId = process.env.WHATSAPP_COMPREHENSION_FLOW_ID;
  if (!flowId) {
    logger.error(
      'WHATSAPP_COMPREHENSION_FLOW_ID is not set — cannot send comprehension flow',
    );
    return;
  }
  let payload: FlowMediaPayload;
  try {
    payload = JSON.parse(entity.text ?? '') as FlowMediaPayload;
  } catch {
    logger.error(`Flow media ${entity.id} has unparseable payload — skipping`);
    return;
  }
  if (
    typeof payload?.question_text !== 'string' ||
    !Array.isArray(payload.options) ||
    payload.options.length < 2 ||
    payload.options.length > FLOW_OPTION_LETTERS.length
  ) {
    logger.error(`Flow media ${entity.id} has malformed payload — skipping`);
    return;
  }
  const options = shuffled(payload.options).map((option, i) => ({
    id: option.id,
    title: FLOW_OPTION_LETTERS[i],
    description: option.text.slice(0, FLOW_OPTION_DESCRIPTION_MAX),
  }));
  items.push({
    type: 'flow',
    flow: {
      flow_id: flowId,
      body: FLOW_MESSAGE_BODY,
      cta: FLOW_MESSAGE_CTA,
      screen: COMPREHENSION_FLOW_SCREEN,
      data: { question_text: payload.question_text, options },
    },
  });
  if (records) {
    records.push({
      media_metadata_id: entity.id,
      state_transition_id: stateTransitionId ?? null,
    });
  }
}

export function appendMediaItems(
  items: OutboundMediaItem[],
  media: FindMediaByStateTransitionIdResult,
  records?: OutboundSentItem[],
  stateTransitionId?: string,
): void {
  for (const type of ['video', 'audio', 'image', 'sticker', 'text'] as const) {
    const entity = media[type];
    if (!entity) continue;
    if (type === 'text') {
      items.push({ type: 'text', body: entity.text! });
    } else {
      const mime_type = (entity.media_details as { mime_type?: string } | null)
        ?.mime_type;
      items.push({ type, url: entity.wa_media_url!, mime_type });
    }
    if (records) {
      records.push({
        media_metadata_id: entity.id,
        state_transition_id: stateTransitionId ?? null,
      });
    }
  }
  // Flows go LAST so the question lands after any praise/prompt media (order
  // within one bundle is best-effort on WhatsApp's side regardless).
  if (media.flow) {
    appendFlowItem(items, media.flow, records, stateTransitionId);
  }
}

export async function sendFallbackAndHandle(
  wabotOutbound: WabotOutboundService,
  payload: MessageJobDto,
  ctx: Context,
): Promise<void> {
  try {
    const fallbackUrl = process.env.FALL_BACK_MESSAGE_PUBLIC_URL!;
    await wabotOutbound.sendMessage({
      user_external_id: payload.message.from,
      wamid: payload.message.id,
      media: [{ type: 'video', url: fallbackUrl }],
      otel_carrier: injectCarrierFromContext(ctx),
    });
  } catch (err) {
    logger.warn(`Failed to send fallback message: ${(err as Error).message}`);
  }
}

export function handleSendResult(
  result: { status: number; body: any },
  label: string,
): void {
  if (result.status >= 400 && result.status < 500) {
    logger.error(`${label} sendMessage 4XX: ${result.status}`);
  } else if (result.status >= 500) {
    logger.warn(`${label} sendMessage 5XX: ${result.status}`);
  }
}

// Sends the "please send a voice note" video to a user whose message was not
// audio. The prompt media must be seeded for AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID:
// a missing row is a config/data bug, so it fails loud (the user still gets
// wabot's timeout fallback). Send failures are logged and swallowed.
export async function sendAudioOnlyRedirect(
  mediaMetaDataService: MediaMetaDataService,
  wabotOutbound: WabotOutboundService,
  options: { user: User; payload: MessageJobDto; ctx: Context },
): Promise<void> {
  const { user, payload, ctx } = options;
  const audioOnlyMedia =
    await mediaMetaDataService.findMediaByStateTransitionId(
      AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID,
    );
  if (!audioOnlyMedia.video) {
    logger.error(
      `Missing media for ${AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID} — cannot send audio-only prompt`,
    );
    throw new Error(
      `audio-only redirect media missing for ${AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID}`,
    );
  }
  try {
    const result = await wabotOutbound.sendMessage({
      user_external_id: user.external_id,
      wamid: payload.message.id,
      media: [
        {
          type: 'video',
          url: audioOnlyMedia.video.wa_media_url!,
        },
      ],
      otel_carrier: injectCarrierFromContext(ctx),
    });
    handleSendResult(result, 'audio-only');
  } catch (err) {
    logger.warn(`Failed to send audio-only message: ${(err as Error).message}`);
  }
}

// Persists an inbound voice note (idempotent by wa_media_url, so retries
// reuse the same entity), re-arms the hail-mary timer (best effort) and
// returns the STT transcripts. Throws when no transcript exists — the job
// cannot proceed without one.
export async function persistAndTranscribeAudio(
  mediaMetaDataService: MediaMetaDataService,
  options: { payload: MessageJobDto; user: User; span: Span },
): Promise<{ audioEntity: MediaMetaData; transcripts: MediaMetaData[] }> {
  const { payload, user, span } = options;
  const audioEntity = await mediaMetaDataService.createWhatsappAudioMedia({
    wa_media_url: payload.message.audio!.url,
    user,
    otel_carrier: injectCarrier(span),
  });

  try {
    await rearmHailMary({
      user_id: user.id,
      user_external_id: user.external_id,
      user_message_id: audioEntity.id,
      otel_carrier: injectCarrier(span),
    });
  } catch (err) {
    logger.warn(
      `rearmHailMary failed for user ${toLogId(user.external_id)}: ${(err as Error).message}`,
    );
  }

  const transcripts = await mediaMetaDataService.findTranscripts({
    media_metadata: audioEntity,
  });

  if (transcripts.length === 0) {
    logger.error(`No transcripts found for audio ${audioEntity.id}`);
    throw new Error('No transcripts');
  }

  return { audioEntity, transcripts };
}
