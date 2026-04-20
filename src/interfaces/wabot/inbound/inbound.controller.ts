import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SpanStatusCode } from '@opentelemetry/api';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MessageJobDto } from './wabot-inbound.dto';
import { createQueue, QUEUE_NAMES } from '../../redis/queues';
import {
  startChildSpanWithContext,
  injectCarrierFromContext,
} from '../../../otel/otel';

const wabotInboundQueue = createQueue(QUEUE_NAMES.WABOT_INBOUND);

@Controller('wabot/inbound')
export class WabotInboundController {
  private readonly logger = new Logger(WabotInboundController.name);

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(@Body() body: unknown) {
    // Opportunistically extract the OTel carrier from the raw body BEFORE
    // validation so that malformed payloads still produce a trace. If the
    // carrier is missing or malformed, startChildSpanWithContext({}) produces
    // a root span — validation failures are still visible in Tempo, just not
    // linked to an upstream trace.
    const maybeCarrier = (body as { otel?: { carrier?: unknown } } | null)?.otel
      ?.carrier;
    const safeCarrier: Record<string, string> =
      maybeCarrier !== null &&
      typeof maybeCarrier === 'object' &&
      !Array.isArray(maybeCarrier)
        ? Object.fromEntries(
            Object.entries(maybeCarrier as Record<string, unknown>).filter(
              ([, v]) => typeof v === 'string',
            ) as [string, string][],
          )
        : {};

    const { span, ctx } = startChildSpanWithContext(
      'wabot-inbound-controller',
      safeCarrier,
    );

    try {
      // 1. Validate
      const dto = plainToInstance(MessageJobDto, body);
      const errors = await validate(dto);
      if (errors.length > 0) {
        const detail = errors
          .map((e) => Object.values(e.constraints ?? {}))
          .flat()
          .join(', ');
        span.setAttribute('pp.validation.failed', true);
        throw new BadRequestException('Invalid message payload: ' + detail);
      }

      span.setAttribute('wabot.wamid', dto.message.id);
      span.setAttribute('wabot.user.external_id', dto.message.from);
      span.setAttribute('wabot.message.type', dto.message.type);
      span.setAttribute('pp.queue', QUEUE_NAMES.WABOT_INBOUND);

      // 2. Inject carrier (carries baggage + new span forward to worker)
      const jobPayload = {
        ...dto,
        otel: { carrier: injectCarrierFromContext(ctx) },
      };

      // 3. Enqueue with retry
      let enqueued = false;
      let delay = 1000;
      const startTime = Date.now();
      while (!enqueued) {
        try {
          await wabotInboundQueue.add('wabot-inbound', jobPayload);
          enqueued = true;
        } catch (err) {
          if (Date.now() - startTime > 10_000) {
            this.logger.error('Failed to enqueue wabot inbound job');
            throw new InternalServerErrorException('Failed to process message');
          }
          this.logger.warn(`Enqueue retry: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 10_000);
        }
      }

      // 4. Return 202
      return { status: 'accepted' };
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  }
}
