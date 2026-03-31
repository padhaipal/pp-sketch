import { initOtel } from './otel/otel';
initOtel();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { createWorker, QUEUE_NAMES } from './interfaces/redis/queues';
import { processWabotInboundJob } from './interfaces/wabot/inbound/inbound.processor';
import { processHeygenInboundJob } from './interfaces/heygen/inbound/inbound.processor';
import { processHeygenGenerateJob } from './interfaces/heygen/outbound/outbound.service';
import { processWhatsappPreloadJob } from './media-meta-data/whatsapp-preload.processor';
import { UserService } from './users/user.service';
import { MediaMetaDataService } from './media-meta-data/media-meta-data.service';
import { LiteracyLessonService } from './literacy/literacy-lesson/literacy-lesson.service';
import { WabotOutboundService } from './interfaces/wabot/outbound/outbound.service';
import { MediaBucketService } from './interfaces/media-bucket/outbound/outbound.service';
import { CacheService } from './interfaces/redis/cache';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('PadhaiPal API')
    .setDescription('PadhaiPal backend API')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  // Resolve services for BullMQ processors
  const userService = app.get(UserService);
  const mediaMetaDataService = app.get(MediaMetaDataService);
  const literacyLessonService = app.get(LiteracyLessonService);
  const wabotOutbound = app.get(WabotOutboundService);
  const mediaBucket = app.get(MediaBucketService);
  const cacheService = app.get(CacheService);

  // BullMQ workers
  createWorker(QUEUE_NAMES.WABOT_INBOUND, async (job) => {
    await processWabotInboundJob(
      job,
      userService,
      mediaMetaDataService,
      literacyLessonService,
      wabotOutbound,
    );
  });

  createWorker(QUEUE_NAMES.HEYGEN_GENERATE, async (job) => {
    await processHeygenGenerateJob(job, mediaBucket);
  });

  createWorker(QUEUE_NAMES.HEYGEN_INBOUND, async (job) => {
    await processHeygenInboundJob(job, mediaBucket);
  });

  createWorker(QUEUE_NAMES.WHATSAPP_PRELOAD, async (job) => {
    await processWhatsappPreloadJob(
      job,
      mediaBucket,
      wabotOutbound,
      cacheService,
    );
  });

  logger.log('BullMQ workers started for all 4 queues');

  await app.listen(process.env.PORT ?? 3000);
  logger.log(`Application listening on port ${process.env.PORT ?? 3000}`);
}
bootstrap();
