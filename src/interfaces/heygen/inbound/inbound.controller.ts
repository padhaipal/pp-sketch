import {
  Controller,
  Post,
  Req,
  HttpCode,
  HttpStatus,
  Logger,
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as crypto from 'crypto';
import type { Request } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { HeygenWebhookDto } from './inbound.dto';
import { createQueue, QUEUE_NAMES } from '../../redis/queues';
import { startRootSpan, injectCarrier } from '../../../otel/otel';

const heygenInboundQueue = createQueue(QUEUE_NAMES.HEYGEN_INBOUND);

@ApiTags('heygen-webhook')
@Controller('heygen/webhook')
export class HeygenInboundController {
  private readonly logger = new Logger(HeygenInboundController.name);

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() req: RawBodyRequest<Request>) {
    const rawBody = Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf-8')
      : JSON.stringify(req.body);
    const signatureHeader = req.headers['signature'] as string | undefined;
    const secret = process.env.HEYGEN_WEBHOOK_SECRET!;

    // 1. Verify signature
    if (!signatureHeader) {
      this.logger.warn('Missing Signature header');
      throw new UnauthorizedException('Missing signature');
    }

    const computed = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    const computedBuf = Buffer.from(computed);
    const signatureBuf = Buffer.from(signatureHeader);
    if (
      computedBuf.length !== signatureBuf.length ||
      !crypto.timingSafeEqual(computedBuf, signatureBuf)
    ) {
      this.logger.warn('HeyGen webhook signature mismatch');
      throw new UnauthorizedException('Invalid signature');
    }

    // 2. Validate body
    const parsed =
      typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const dto = plainToInstance(HeygenWebhookDto, parsed);
    const errors = await validate(dto);
    if (errors.length > 0) {
      throw new BadRequestException('Invalid webhook payload');
    }

    // 3. Start span
    const span = startRootSpan('heygen-inbound-controller');

    // 4. Enqueue with retry
    let enqueued = false;
    let delay = 1000;
    const startTime = Date.now();
    while (!enqueued) {
      try {
        await heygenInboundQueue.add('heygen-inbound', {
          event_type: dto.event_type,
          event_data: dto.event_data,
          otel_carrier: injectCarrier(span),
        });
        enqueued = true;
      } catch (err) {
        if (Date.now() - startTime > 10_000) {
          this.logger.error('Failed to enqueue HeyGen inbound job');
          span.end();
          throw new InternalServerErrorException('Failed to process webhook');
        }
        this.logger.warn(`Enqueue retry: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    }

    // 5. Return 200
    span.end();
    return { status: 'ok' };
  }
}
