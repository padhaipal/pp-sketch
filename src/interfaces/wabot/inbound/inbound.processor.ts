import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { Context } from '@opentelemetry/api';
import { MessageJobDto } from './wabot-inbound.dto';
import { UserService } from '../../../users/user.service';
import { MediaMetaDataService } from '../../../media-meta-data/media-meta-data.service';
import { LiteracyLessonService } from '../../../literacy/literacy-lesson/literacy-lesson.service';
import { WabotOutboundService } from '../outbound/outbound.service';
import { OutboundMediaItem } from '../outbound/outbound.dto';
import {
  startChildSpanWithContext,
  injectCarrier,
  injectCarrierFromContext,
} from '../../../otel/otel';
import { FindMediaByStateTransitionIdResult } from '../../../media-meta-data/media-meta-data.dto';
import { WELCOME_MESSAGE_STATE_TRANSITION_ID, AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID } from '../../../literacy/literacy-lesson/literacy-lesson.machine';

const logger = new Logger('WabotInboundProcessor');

export async function processWabotInboundJob(
  job: Job<MessageJobDto>,
  userService: UserService,
  mediaMetaDataService: MediaMetaDataService,
  literacyLessonService: LiteracyLessonService,
  wabotOutbound: WabotOutboundService,
): Promise<void> {
  const payload = job.data;

  // 0. Start span (preserve baggage from incoming carrier so it flows back
  //    out to wabot on any outbound sendMessage calls)
  const { span, ctx } = startChildSpanWithContext(
    'wabot-inbound-processor',
    payload.otel.carrier,
  );

  try {
    // 1. System message — phone number change
    if (payload.message.type === 'system') {
      const oldPhone = payload.message.from;
      const newPhone = payload.message.system!.wa_id;

      const updated = await userService.update({
        external_id: oldPhone,
        new_external_id: newPhone,
      });

      if (!updated) {
        logger.error(
          `System message: user not found for old phone ${oldPhone}`,
        );
        span.end();
        throw new Error('User not found for phone number change');
      }

      logger.log(`Updated user phone: ${oldPhone} → ${newPhone}`);
      span.end();
      return;
    }

    // 2. Consecutive message — ignore
    if (payload.consecutive) {
      logger.log(
        `Ignoring consecutive message from ${payload.message.from}`,
      );
      span.end();
      return;
    }

    // 3. Find or create user
    let user = await userService.find({
      external_id: payload.message.from,
    });

    if (!user) {
      // Try to find referrer from text body
      let referrerExternalId: string | undefined;

      if (payload.message.type === 'text' && payload.message.text) {
        const body = payload.message.text.body;
        const tokens = body.split(/\s+/);
        for (const token of tokens) {
          const candidates = [
            token,
            ...Array.from(token.matchAll(/\d{7,}/g)).map((m) => m[0]),
          ];
          for (const candidate of candidates) {
            const parsed = parsePhoneNumberFromString(candidate, 'IN');
            if (
              parsed &&
              parsed.isValid() &&
              parsed.format('E.164') !== payload.message.from
            ) {
              referrerExternalId = parsed.format('E.164');
              break;
            }
          }
          if (referrerExternalId) break;
        }
      }

      // Create user
      try {
        if (referrerExternalId) {
          const referrer = await userService.find({
            external_id: referrerExternalId,
          });
          if (!referrer) {
            logger.log(
              `Referrer ${referrerExternalId} not found — creating user without referrer`,
            );
            referrerExternalId = undefined;
          }
        }

        user = await userService.create({
          external_id: payload.message.from,
          referrer_external_id: referrerExternalId,
        });
      } catch (err) {
        logger.error(
          `Failed to create user ${payload.message.from}: ${(err as Error).message}`,
        );
        await sendFallbackAndHandle(wabotOutbound, payload, ctx);
        span.end();
        throw err;
      }

      // Save user's message
      let userMessageId: string | undefined;
      try {
        if (payload.message.type === 'text') {
          const textEntity = await mediaMetaDataService.createTextMedia({
            text: payload.message.text!.body,
            user,
          });
          userMessageId = textEntity.id;
        } else if (payload.message.type === 'audio') {
          const audioEntity =
            await mediaMetaDataService.createWhatsappAudioMedia({
              wa_media_url: payload.message.audio!.url,
              user,
              otel_carrier: injectCarrier(span),
            });
          userMessageId = audioEntity.id;
        } else {
          logger.error(
            `New user ${user.external_id} sent unsupported type "${payload.message.type}" — sending welcome only`,
          );
        }
      } catch (err) {
        logger.warn(
          `Failed to save new user message: ${(err as Error).message}`,
        );
      }

      // Build outbound media: welcome + first lesson
      const onboardingMedia: OutboundMediaItem[] = [];
      const onboardingStids: string[] = [];

      try {
        const welcomeMedia =
          await mediaMetaDataService.findMediaByStateTransitionId(
            WELCOME_MESSAGE_STATE_TRANSITION_ID,
          );
        appendMediaItems(onboardingMedia, welcomeMedia);
        onboardingStids.push(WELCOME_MESSAGE_STATE_TRANSITION_ID);
      } catch (err) {
        logger.warn(
          `Failed to fetch welcome media: ${(err as Error).message}`,
        );
      }

      if (userMessageId) {
        try {
          const lessonResult = await literacyLessonService.processAnswer({
            user,
            user_message_id: userMessageId,
          });
          for (const stid of lessonResult.stateTransitionIds) {
            const lessonMedia =
              await mediaMetaDataService.findMediaByStateTransitionId(stid);
            appendMediaItems(onboardingMedia, lessonMedia);
            onboardingStids.push(stid);
          }
        } catch (err) {
          logger.warn(
            `Failed to start first lesson for new user ${user.external_id}: ${(err as Error).message}`,
          );
        }
      } else {
        logger.warn(`New-user first lesson skipped: userMessageId is undefined`);
      }

      if (onboardingMedia.length > 0) {
        try {
          const result = await wabotOutbound.sendMessage({
            user_external_id: user.external_id,
            wamid: payload.message.id,
            media: onboardingMedia,
            otel_carrier: injectCarrierFromContext(ctx),
          });
          handleSendResult(result, 'new-user-onboarding');
        } catch (err) {
          logger.warn(
            `Failed to send new-user onboarding: ${(err as Error).message}`,
          );
        }
      }

      span.end();
      return;
    }

    // 4. Check timestamp (20 second staleness)
    const tsRaw = parseInt(payload.message.timestamp, 10);
    const tsMs = tsRaw <= 9_999_999_999 ? tsRaw * 1000 : tsRaw;

    if (Date.now() - tsMs > 20_000) {
      logger.warn(
        `Message from ${payload.message.from} is older than 20s — skipping`,
      );
      span.end();
      return;
    }

    // 5. Non-audio message — send "audio only" video
    if (payload.message.type !== 'audio') {
      try {
        const audioOnlyMedia =
          await mediaMetaDataService.findMediaByStateTransitionId(
            AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID,
          );
        if (audioOnlyMedia.video) {
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
        }
      } catch (err) {
        logger.warn(
          `Failed to send audio-only message: ${(err as Error).message}`,
        );
      }
      span.end();
      return;
    }

    // 6. Process audio message
    const audioEntity =
      await mediaMetaDataService.createWhatsappAudioMedia({
        wa_media_url: payload.message.audio!.url,
        user,
        otel_carrier: injectCarrier(span),
      });
    const userMessageId = audioEntity.id;

    // 7. Find transcripts
    const transcripts = await mediaMetaDataService.findTranscripts({
      media_metadata: audioEntity,
    });

    if (transcripts.length === 0) {
      logger.error(`No transcripts found for audio ${audioEntity.id}`);
      span.end();
      throw new Error('No transcripts');
    }

    // 8. Process answer
    const result1 = await literacyLessonService.processAnswer({
      user,
      transcripts,
      user_message_id: userMessageId,
    });
    const stateTransitionIds: string[] = [...result1.stateTransitionIds];

    // If lesson complete, start fresh
    if (result1.isComplete) {
      const result2 = await literacyLessonService.processAnswer({
        user,
        user_message_id: userMessageId,
      });
      stateTransitionIds.push(...result2.stateTransitionIds);
    }

    // 9. Build outbound media
    const outboundMedia: OutboundMediaItem[] = [];

    for (const stid of stateTransitionIds) {
      const media =
        await mediaMetaDataService.findMediaByStateTransitionId(stid);
      appendMediaItems(outboundMedia, media);
    }

    // 10. Send outbound
    const sendResult = await wabotOutbound.sendMessage({
      user_external_id: user.external_id,
      wamid: payload.message.id,
      consecutive: payload.consecutive,
      media: outboundMedia,
      otel_carrier: injectCarrierFromContext(ctx),
    });

    if (sendResult.status >= 200 && sendResult.status < 300) {
      if (sendResult.body.delivered) {
        logger.log(`Message delivered to ${user.external_id}`);
      } else {
        // Inflight expired — roll back
        logger.log(
          `Inflight expired for ${user.external_id} — rolling back`,
        );
        await mediaMetaDataService.markRolledBack(userMessageId);
      }
    } else if (sendResult.status >= 400 && sendResult.status < 500) {
      logger.error(
        `sendMessage 4XX: ${sendResult.status} for ${user.external_id}`,
      );
      span.end();
      throw new Error(`sendMessage 4XX: ${sendResult.status}`);
    } else {
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isLastAttempt) {
        logger.error(
          `sendMessage 5XX (final attempt): ${sendResult.status} for ${user.external_id}`,
        );
      } else {
        logger.warn(
          `sendMessage 5XX (attempt ${job.attemptsMade + 1}): ${sendResult.status} for ${user.external_id}`,
        );
      }
      span.end();
      throw new Error(`sendMessage 5XX: ${sendResult.status}`);
    }

    span.end();
  } catch (err) {
    span.end();
    throw err;
  }
}

function appendMediaItems(
  items: OutboundMediaItem[],
  media: FindMediaByStateTransitionIdResult,
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
  }
}

async function sendFallbackAndHandle(
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
    logger.warn(
      `Failed to send fallback message: ${(err as Error).message}`,
    );
  }
}

function handleSendResult(
  result: { status: number; body: any },
  context: string,
): void {
  if (result.status >= 400 && result.status < 500) {
    logger.error(`${context} sendMessage 4XX: ${result.status}`);
  } else if (result.status >= 500) {
    logger.warn(`${context} sendMessage 5XX: ${result.status}`);
  }
}
