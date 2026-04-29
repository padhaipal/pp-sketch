import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { context, SpanStatusCode, type Context } from '@opentelemetry/api';
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
import { wabotInboundJobDuration } from '../../../otel/metrics';
import { toLogId } from '../../../otel/pii';
import { FindMediaByStateTransitionIdResult } from '../../../media-meta-data/media-meta-data.dto';
import {
  WELCOME_MESSAGE_STATE_TRANSITION_ID,
  AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID,
} from '../../../literacy/literacy-lesson/literacy-lesson.machine';
import { rearmHailMary } from '../../../notifier/hail-mary.processor';

const logger = new Logger('WabotInboundProcessor');

type JobOutcome = 'success' | 'skipped' | 'error';

export async function processWabotInboundJob(
  job: Job<MessageJobDto>,
  userService: UserService,
  mediaMetaDataService: MediaMetaDataService,
  literacyLessonService: LiteracyLessonService,
  wabotOutbound: WabotOutboundService,
): Promise<void> {
  const payload = job.data;

  // Start span (preserve baggage from incoming carrier so it flows back
  // out to wabot on any outbound sendMessage calls).
  const { span, ctx } = startChildSpanWithContext(
    'wabot-inbound-processor',
    payload.otel.carrier,
  );

  span.setAttribute('wabot.wamid', payload.message.id);
  span.setAttribute(
    'wabot.user.external_id_hash',
    toLogId(payload.message.from),
  );
  span.setAttribute('wabot.message.type', payload.message.type);
  span.setAttribute('wabot.consecutive', !!payload.consecutive);

  const startTime = performance.now();
  let outcome: JobOutcome = 'error';
  let path: string | undefined;

  try {
    await context.with(ctx, async () => {
      // 1. System message — phone number change
      if (payload.message.type === 'system') {
        path = 'system';
        const oldPhone = payload.message.from;
        const newPhone = payload.message.system!.wa_id;

        const updated = await userService.update({
          external_id: oldPhone,
          new_external_id: newPhone,
        });

        if (!updated) {
          logger.error(
            `System message: user not found for old phone ${toLogId(oldPhone)}`,
          );
          throw new Error('User not found for phone number change');
        }

        logger.log(
          `Updated user phone: ${toLogId(oldPhone)} → ${toLogId(newPhone)}`,
        );
        outcome = 'success';
        return;
      }

      // 2. Consecutive message — ignore
      if (payload.consecutive) {
        path = 'consecutive-skip';
        logger.log(
          `Ignoring consecutive message from ${toLogId(payload.message.from)}`,
        );
        outcome = 'skipped';
        return;
      }

      // 3. Find or create user
      let user = await userService.find({
        external_id: payload.message.from,
      });

      if (!user) {
        path = 'new-user';

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
                `Referrer ${toLogId(referrerExternalId)} not found — creating user without referrer`,
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
            `Failed to create user ${toLogId(payload.message.from)}: ${(err as Error).message}`,
          );
          await sendFallbackAndHandle(wabotOutbound, payload, ctx);
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
            try {
              await rearmHailMary({
                user_id: user.id,
                user_external_id: user.external_id,
                user_message_id: audioEntity.id,
                otel_carrier: injectCarrier(span),
              });
            } catch (err) {
              logger.warn(
                `rearmHailMary failed for new user ${toLogId(user.external_id)}: ${(err as Error).message}`,
              );
            }
          } else {
            logger.error(
              `New user ${toLogId(user.external_id)} sent unsupported type "${payload.message.type}" — sending welcome only`,
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

        // Tappable referral link, sent between the welcome bundle and the
        // first lesson. Same URL the morning-update notifier uses.
        const referralUrl = `https://dashboard.padhaipal.com/r/${user.external_id}`;
        onboardingMedia.push({
          type: 'text',
          body: `To send PadhaiPal to your friends send them this link: ${referralUrl}`,
        });

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
              `Failed to start first lesson for new user ${toLogId(user.external_id)}: ${(err as Error).message}`,
            );
          }
        } else {
          logger.warn(
            `New-user first lesson skipped: userMessageId is undefined`,
          );
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

        outcome = 'success';
        return;
      }

      // 4. Check timestamp (20 second staleness)
      const tsRaw = parseInt(payload.message.timestamp, 10);
      const tsMs = tsRaw <= 9_999_999_999 ? tsRaw * 1000 : tsRaw;

      if (Date.now() - tsMs > 20_000) {
        path = 'stale-skip';
        logger.warn(
          `Message from ${toLogId(payload.message.from)} is older than 20s — skipping`,
        );
        outcome = 'skipped';
        return;
      }

      // 5. Non-audio message — send "audio only" video
      if (payload.message.type !== 'audio') {
        path = 'non-audio-redirect';
        const audioOnlyMedia =
          await mediaMetaDataService.findMediaByStateTransitionId(
            AUDIO_ONLY_REQUEST_STATE_TRANSITION_ID,
          );
        // Config/data bug: the audio-only prompt media must be seeded for this
        // state transition. Fail loud so it shows up in alerts; the user still
        // gets wabot's timeout fallback so UX doesn't regress.
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
          logger.warn(
            `Failed to send audio-only message: ${(err as Error).message}`,
          );
        }
        outcome = 'success';
        return;
      }

      // 6. Process audio message
      path = 'audio-reply';
      const audioEntity = await mediaMetaDataService.createWhatsappAudioMedia({
        wa_media_url: payload.message.audio!.url,
        user,
        otel_carrier: injectCarrier(span),
      });
      const userMessageId = audioEntity.id;

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

      // On retry, wipe any partial DB writes from prior attempts so
      // processAnswer runs against a clean slate for this user_message_id.
      if (job.attemptsMade > 0) {
        await literacyLessonService.cleanupPartialState(userMessageId);
      }

      // 7. Find transcripts
      const transcripts = await mediaMetaDataService.findTranscripts({
        media_metadata: audioEntity,
      });

      if (transcripts.length === 0) {
        logger.error(`No transcripts found for audio ${audioEntity.id}`);
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

      // Daily activity quota check — disabled until 'daily-activity-quota-reached'
      // media is seeded. Uncomment along with injecting UserActivityService.
      // const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
      // const now = new Date();
      // const istNow = new Date(now.getTime() + IST_OFFSET_MS);
      // const istMidnight = new Date(
      //   Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()),
      // );
      // const midnight = new Date(istMidnight.getTime() - IST_OFFSET_MS);
      // const activity = await userActivityService.getActivityTime({
      //   users: [user.id],
      //   windows: [{ start: midnight.toISOString(), end: now.toISOString() }],
      // });
      // const activeMs = activity.results[0]?.windows[0]?.active_ms ?? 0;
      // if (activeMs > 5 * 60 * 1000) {
      //   stateTransitionIds.unshift('daily-activity-quota-reached');
      // }

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
          logger.log(`Message delivered to ${toLogId(user.external_id)}`);
        } else {
          // Inflight expired — roll back
          logger.log(
            `Inflight expired for ${toLogId(user.external_id)} — rolling back`,
          );
          await mediaMetaDataService.markRolledBack(userMessageId);
        }
        outcome = 'success';
      } else if (sendResult.status >= 400 && sendResult.status < 500) {
        logger.error(
          `sendMessage 4XX: ${sendResult.status} for ${toLogId(user.external_id)}`,
        );
        throw new Error(`sendMessage 4XX: ${sendResult.status}`);
      } else {
        const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (isLastAttempt) {
          logger.error(
            `sendMessage 5XX (final attempt): ${sendResult.status} for ${toLogId(user.external_id)}`,
          );
        } else {
          logger.warn(
            `sendMessage 5XX (attempt ${job.attemptsMade + 1}): ${sendResult.status} for ${toLogId(user.external_id)}`,
          );
        }
        throw new Error(`sendMessage 5XX: ${sendResult.status}`);
      }
    });
  } catch (err) {
    outcome = 'error';
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (err as Error).message,
    });
    span.recordException(err as Error);
    throw err;
  } finally {
    if (path !== undefined) {
      span.setAttribute('pp.path', path);
    }
    span.setAttribute('pp.outcome', outcome);
    span.end();
    wabotInboundJobDuration.record(performance.now() - startTime, { outcome });
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
    logger.warn(`Failed to send fallback message: ${(err as Error).message}`);
  }
}

function handleSendResult(
  result: { status: number; body: any },
  label: string,
): void {
  if (result.status >= 400 && result.status < 500) {
    logger.error(`${label} sendMessage 4XX: ${result.status}`);
  } else if (result.status >= 500) {
    logger.warn(`${label} sendMessage 5XX: ${result.status}`);
  }
}
