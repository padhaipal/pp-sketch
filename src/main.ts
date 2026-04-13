import dns from 'node:dns';
dns.setDefaultResultOrder('verbatim');

import { initOtel } from './otel/otel';
initOtel();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { MediaMetaDataEntity } from './media-meta-data/media-meta-data.entity';
import { createWorker, QUEUE_NAMES } from './interfaces/redis/queues';
import { processWabotInboundJob } from './interfaces/wabot/inbound/inbound.processor';
import { processHeygenInboundJob } from './interfaces/heygen/inbound/inbound.processor';
import { processHeygenGenerateJob } from './interfaces/heygen/outbound/outbound.service';
import { processElevenlabsGenerateJob } from './interfaces/elevenlabs/outbound/outbound.service';
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
    bodyParser: false,
  });

  // Route-scoped 5mb body limit for bulk audio-generation endpoints; must be registered BEFORE the
  // global default parser so the specific route matches first.
  app.use('/media-meta-data/elevenlabs-generate', json({ limit: '5mb' }));
  app.use('/media-meta-data/heygen-generate', json({ limit: '5mb' }));
  // Default body parsers (Nest's built-in parser is disabled above).
  app.use(json());
  app.use(urlencoded({ extended: true }));

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
  const dataSource = app.get(DataSource);
  const mediaRepo = dataSource.getRepository(MediaMetaDataEntity);
  const userService = app.get(UserService);
  const mediaMetaDataService = app.get(MediaMetaDataService);
  const literacyLessonService = app.get(LiteracyLessonService);
  const wabotOutbound = app.get(WabotOutboundService);
  const mediaBucket = app.get(MediaBucketService);
  const cacheService = app.get(CacheService);

  // BullMQ workers
  logger.log(`[HPTRACE] BULLMQ_REDIS_URL set=${!!process.env.BULLMQ_REDIS_URL}`);
  logger.log(`[HPTRACE] Registering worker for queue=${QUEUE_NAMES.WABOT_INBOUND}`);
  const wabotInboundWorker = createWorker(QUEUE_NAMES.WABOT_INBOUND, async (job) => {
    logger.log(`[HPTRACE] worker(${QUEUE_NAMES.WABOT_INBOUND}) picked up job id=${job.id} name=${job.name}`);
    await processWabotInboundJob(
      job,
      userService,
      mediaMetaDataService,
      literacyLessonService,
      wabotOutbound,
    );
    logger.log(`[HPTRACE] worker(${QUEUE_NAMES.WABOT_INBOUND}) finished job id=${job.id}`);
  });
  wabotInboundWorker.on('ready', () => logger.log(`[HPTRACE] worker(${QUEUE_NAMES.WABOT_INBOUND}) READY`));
  wabotInboundWorker.on('active', (job) => logger.log(`[HPTRACE] worker(${QUEUE_NAMES.WABOT_INBOUND}) ACTIVE job id=${job.id}`));
  wabotInboundWorker.on('completed', (job) => logger.log(`[HPTRACE] worker(${QUEUE_NAMES.WABOT_INBOUND}) COMPLETED job id=${job.id}`));
  wabotInboundWorker.on('failed', (job, err) => logger.error(`[HPTRACE] worker(${QUEUE_NAMES.WABOT_INBOUND}) FAILED job id=${job?.id} err=${err.message}`));
  wabotInboundWorker.on('error', (err) => logger.error(`[HPTRACE] worker(${QUEUE_NAMES.WABOT_INBOUND}) ERROR ${err.message}`));
  wabotInboundWorker.on('stalled', (jobId) => logger.warn(`[HPTRACE] worker(${QUEUE_NAMES.WABOT_INBOUND}) STALLED job id=${jobId}`));

  createWorker(QUEUE_NAMES.HEYGEN_GENERATE, async (job) => {
    await processHeygenGenerateJob(job, mediaBucket, mediaRepo);
  });

  createWorker(QUEUE_NAMES.ELEVENLABS_GENERATE, async (job) => {
    await processElevenlabsGenerateJob(job, mediaBucket, mediaRepo);
  });

  createWorker(QUEUE_NAMES.HEYGEN_INBOUND, async (job) => {
    await processHeygenInboundJob(job, mediaBucket, mediaRepo);
  });

  createWorker(QUEUE_NAMES.WHATSAPP_PRELOAD, async (job) => {
    await processWhatsappPreloadJob(
      job,
      mediaBucket,
      wabotOutbound,
      cacheService,
      mediaRepo,
    );
  });

  logger.log('BullMQ workers started for all 5 queues');

  await app.listen(process.env.PORT ?? 3000);
  logger.log(`Application listening on port ${process.env.PORT ?? 3000}`);
}
bootstrap();
