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
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MessageJobDto } from './wabot-inbound.dto';
import { createQueue, QUEUE_NAMES } from '../../redis/queues';
import { startChildSpan, injectCarrier } from '../../../otel/otel';

const wabotInboundQueue = createQueue(QUEUE_NAMES.WABOT_INBOUND);

@Controller('wabot/inbound')
export class WabotInboundController {
  private readonly logger = new Logger(WabotInboundController.name);

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(@Body() body: unknown) {
    // 1. Validate
    const dto = plainToInstance(MessageJobDto, body);
    const errors = await validate(dto);
    if (errors.length > 0) {
      throw new BadRequestException(
        'Invalid message payload: ' +
          errors
            .map((e) => Object.values(e.constraints ?? {}))
            .flat()
            .join(', '),
      );
    }

    // 2. Start child span
    const span = startChildSpan(
      'wabot-inbound-controller',
      dto.otel.carrier,
    );

    // 3. Inject carrier
    const jobPayload = {
      ...dto,
      otel: { carrier: injectCarrier(span) },
    };

    // 4. Enqueue with retry
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
          span.end();
          throw new InternalServerErrorException(
            'Failed to process message',
          );
        }
        this.logger.warn(`Enqueue retry: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    }

    // 5. Return 202
    span.end();
    return { status: 'accepted' };
  }
}
