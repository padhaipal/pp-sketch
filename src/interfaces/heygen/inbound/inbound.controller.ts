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
    const rawBodyBuf = req.rawBody;
    const rawBody = hasRawBody
      ? rawBodyBuf!.toString('utf-8')
      : JSON.stringify(req.body);
    const jsonStringified = JSON.stringify(req.body);
    const bodyType = typeof req.body;
    const signatureHeader = req.headers['signature'] as string | undefined;
    const secret = process.env.HEYGEN_WEBHOOK_SECRET!;
    const secretPreview = secret
      ? `${secret.slice(0, 4)}...${secret.slice(-4)} (len=${secret.length})`
      : 'UNDEFINED';

    // Compute HMAC multiple ways to isolate the issue
    const computedFromRawStr = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    const computedFromStringify = crypto
      .createHmac('sha256', secret)
      .update(jsonStringified)
      .digest('hex');
    // Compute directly from Buffer (no toString, avoids encoding issues)
    const computedFromBuf = hasRawBody
      ? crypto.createHmac('sha256', secret).update(rawBodyBuf!).digest('hex')
      : 'N/A';
    // Try with trailing newline (some webhook systems append \n)
    const computedWithNewline = crypto
      .createHmac('sha256', secret)
      .update(rawBody + '\n')
      .digest('hex');

    const xForwardedFor = req.headers['x-forwarded-for'];
    const xRealIp = req.headers['x-real-ip'];
    const allHeaders = Object.keys(req.headers).join(', ');
    const contentType = req.headers['content-type'];
    const userAgent = req.headers['user-agent'];

    // Hex dump last 20 bytes to detect trailing chars
    const lastBytes = hasRawBody
      ? rawBodyBuf!.slice(-20).toString('hex')
      : Buffer.from(rawBody).slice(-20).toString('hex');
    // Full body hash for comparing across requests
    const bodyHash = crypto
      .createHash('sha256')
      .update(rawBody)
      .digest('hex')
      .slice(0, 16);

    this.logger.warn(
      `[DIAG1] hasRawBody=${hasRawBody} | bodyType=${bodyType} | ` +
        `rawBodyLen=${rawBody.length} | stringifyLen=${jsonStringified.length} | ` +
        `rawBody==stringify=${rawBody === jsonStringified} | ` +
        `bodyHash=${bodyHash} | lastBytesHex=${lastBytes}`,
    );
    this.logger.warn(
      `[DIAG2] sig=${signatureHeader ?? 'MISSING'} | ` +
        `fromRawStr=${computedFromRawStr} | ` +
        `fromBuf=${computedFromBuf} | ` +
        `fromStringify=${computedFromStringify} | ` +
        `fromRaw+nl=${computedWithNewline}`,
    );
    this.logger.warn(
      `[DIAG3] match: raw=${computedFromRawStr === signatureHeader} ` +
        `buf=${computedFromBuf === signatureHeader} ` +
        `stringify=${computedFromStringify === signatureHeader} ` +
        `raw+nl=${computedWithNewline === signatureHeader}`,
    );
    this.logger.warn(
      `[DIAG4] secret=${secretPreview} | content-type=${contentType} | ` +
        `user-agent=${userAgent} | x-forwarded-for=${xForwardedFor} | ` +
        `x-real-ip=${xRealIp} | ip=${req.ip} | headers=[${allHeaders}]`,
    );
    this.logger.warn(
      `[DIAG5] fullBody=${rawBody}`,
    );
    // --- END DEBUG ---

    // 1. Verify signature
    if (!signatureHeader) {
      this.logger.warn('Missing Signature header');
      throw new UnauthorizedException('Missing signature');
    }

    const computedBuf = Buffer.from(computedFromRawStr);
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
