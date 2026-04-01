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
    // --- DEBUG: comprehensive webhook diagnostics ---
    const hasRawBody = Buffer.isBuffer(req.rawBody);
    const rawBody = hasRawBody
      ? req.rawBody!.toString('utf-8')
      : JSON.stringify(req.body);
    const jsonStringified = JSON.stringify(req.body);
    const bodyType = typeof req.body;
    const signatureHeader = req.headers['signature'] as string | undefined;
    const secret = process.env.HEYGEN_WEBHOOK_SECRET!;
    const secretPreview = secret
      ? `${secret.slice(0, 4)}...${secret.slice(-4)} (len=${secret.length})`
      : 'UNDEFINED';
    const computedHex = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    // also compute from JSON.stringify for comparison
    const computedFromStringify = crypto
      .createHmac('sha256', secret)
      .update(jsonStringified)
      .digest('hex');

    const allHeaders = Object.keys(req.headers).join(', ');
    const contentType = req.headers['content-type'];
    const userAgent = req.headers['user-agent'];

    this.logger.warn(
      `[DIAG] hasRawBody=${hasRawBody} | bodyType=${bodyType} | ` +
        `rawBodyLen=${rawBody.length} | stringifyLen=${jsonStringified.length} | ` +
        `rawBody==stringify: ${rawBody === jsonStringified} | ` +
        `rawBodyPreview=${rawBody.slice(0, 120)}`,
    );
    this.logger.warn(
      `[DIAG] signatureHeader=${signatureHeader ?? 'MISSING'} | ` +
        `computedFromRaw=${computedHex} | ` +
        `computedFromStringify=${computedFromStringify} | ` +
        `match_raw=${computedHex === signatureHeader} | ` +
        `match_stringify=${computedFromStringify === signatureHeader}`,
    );
    this.logger.warn(
      `[DIAG] secret=${secretPreview} | content-type=${contentType} | ` +
        `user-agent=${userAgent} | headers=[${allHeaders}] | ` +
        `ip=${req.ip} | method=${req.method} | url=${req.originalUrl}`,
    );
    // --- END DEBUG ---

    // 1. Verify signature
    if (!signatureHeader) {
      this.logger.warn('Missing Signature header');
      throw new UnauthorizedException('Missing signature');
    }

    const computedBuf = Buffer.from(computedHex);
    const signatureBuf = Buffer.from(signatureHeader);
    if (
      computedBuf.length !== signatureBuf.length ||
      !crypto.timingSafeEqual(computedBuf, signatureBuf)
    ) {
      this.logger.warn('HeyGen webhook signature mismatch');
      throw new UnauthorizedException('Invalid signature');
    }

    // 3. Validate body
    const parsed =
      typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const dto = plainToInstance(HeygenWebhookDto, parsed);
    const errors = await validate(dto);
    if (errors.length > 0) {
      throw new BadRequestException('Invalid webhook payload');
    }

    // 4. Start span
    const span = startRootSpan('heygen-inbound-controller');

    // 5. Enqueue with retry
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
          throw new InternalServerErrorException(
            'Failed to process webhook',
          );
        }
        this.logger.warn(
          `Enqueue retry: ${(err as Error).message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    }

    // 6. Return 200
    span.end();
    return { status: 'ok' };
  }
}
