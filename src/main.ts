import dns from 'node:dns';
dns.setDefaultResultOrder('verbatim');

import { initOtel } from './otel/otel';
initOtel();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { OtelLogger } from './otel/otel-logger';
import { json, urlencoded } from 'express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { MediaMetaDataEntity } from './media-meta-data/media-meta-data.entity';
import {
  createQueue,
  createWorker,
  QUEUE_NAMES,
} from './interfaces/redis/queues';
import { processWabotInboundJob } from './interfaces/wabot/inbound/inbound.processor';
import { OutboundMessageService } from './outbound-messages/outbound-message.service';
import { processHeygenInboundJob } from './interfaces/heygen/inbound/inbound.processor';
import { processHeygenGenerateJob } from './interfaces/heygen/outbound/outbound.service';
import { processElevenlabsGenerateJob } from './interfaces/elevenlabs/outbound/outbound.service';
import { processWhatsappPreloadJob } from './media-meta-data/whatsapp-preload.processor';
import { processMediaReloadSweepJob } from './media-meta-data/media-reload-sweep.processor';
import {
  processNotifierCronJob,
  processNotifierSendJob,
} from './notifier/evening-reminder.processor';
import {
  processMorningUpdateCronJob,
  processMorningUpdateSendJob,
} from './notifier/morning-update.processor';
import type { MorningUpdateSendJobData } from './notifier/morning-update.processor';
import { processHailMaryJob } from './notifier/hail-mary.processor';
import type { HailMaryJobData } from './notifier/hail-mary.processor';
import { ReportCardService } from './notifier/report-card/report-card.service';
import type { MessageJobDto } from './interfaces/wabot/inbound/wabot-inbound.dto';
import type { HeygenGenerateJobData } from './interfaces/heygen/outbound/outbound.service';
import type { ElevenlabsGenerateJobData } from './interfaces/elevenlabs/outbound/outbound.service';
import type { HeygenInboundJobDto } from './interfaces/heygen/inbound/inbound.dto';
import type { WhatsappPreloadJobDto } from './media-meta-data/media-meta-data.dto';
import type { NotifierSendJobData } from './notifier/evening-reminder.processor';
import { UserService } from './users/user.service';
import { UserActivityService } from './users/user-activity.service';
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
    logger: new OtelLogger(),
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
  const userActivityService = app.get(UserActivityService);
  const mediaMetaDataService = app.get(MediaMetaDataService);
  const literacyLessonService = app.get(LiteracyLessonService);
  const wabotOutbound = app.get(WabotOutboundService);
  const mediaBucket = app.get(MediaBucketService);
  const cacheService = app.get(CacheService);
  const outboundMessageService = app.get(OutboundMessageService);

  // BullMQ workers
  const wabotInboundWorker = createWorker<MessageJobDto>(
    QUEUE_NAMES.WABOT_INBOUND,
    async (job) => {
      await processWabotInboundJob(
        job,
        userService,
        mediaMetaDataService,
        literacyLessonService,
        wabotOutbound,
        userActivityService,
        outboundMessageService,
      );
    },
    // I/O-bound turn (audio download + STT + DB + outbound send); high
    // concurrency overlaps the network waits. Per-replica; the PG pool
    // (extra.max=20) and Postgres max_connections cap effective DB fan-out.
    { concurrency: 100 },
  );
  wabotInboundWorker.on('failed', (job, err) =>
    logger.error(
      `worker(${QUEUE_NAMES.WABOT_INBOUND}) FAILED job id=${job?.id} err=${err.message}`,
    ),
  );
  wabotInboundWorker.on('error', (err) =>
    logger.error(`worker(${QUEUE_NAMES.WABOT_INBOUND}) ERROR ${err.message}`),
  );
  wabotInboundWorker.on('stalled', (jobId) =>
    logger.warn(`worker(${QUEUE_NAMES.WABOT_INBOUND}) STALLED job id=${jobId}`),
  );

  createWorker<HeygenGenerateJobData>(
    QUEUE_NAMES.HEYGEN_GENERATE,
    async (job) => {
      await processHeygenGenerateJob(job, mediaBucket, mediaRepo);
    },
  );

  createWorker<ElevenlabsGenerateJobData>(
    QUEUE_NAMES.ELEVENLABS_GENERATE,
    async (job) => {
      await processElevenlabsGenerateJob(job, mediaBucket, mediaRepo);
    },
  );

  createWorker<HeygenInboundJobDto>(QUEUE_NAMES.HEYGEN_INBOUND, async (job) => {
    await processHeygenInboundJob(job, mediaBucket, mediaRepo);
  });

  // I/O-bound (S3 get + wabot→Meta upload, ~0.9s real / ~0.3s stubbed).
  // Media uploads do NOT count against the WhatsApp message-throughput
  // budget; the 30/s limiter sizes to what wabot's single instance
  // comfortably proxies. Concurrency ≈ rate × ~0.9s upload latency.
  createWorker<WhatsappPreloadJobDto>(
    QUEUE_NAMES.WHATSAPP_PRELOAD,
    async (job) => {
      await processWhatsappPreloadJob(
        job,
        mediaBucket,
        wabotOutbound,
        cacheService,
        mediaRepo,
        mediaMetaDataService,
      );
    },
    {
      concurrency: 32,
      limiter: { max: 30, duration: 1000 },
    },
  );

  // Notifier cron: fires daily at 13:30 UTC = 19:00 IST
  const notifierQueue = createQueue(QUEUE_NAMES.NOTIFIER);
  await notifierQueue.add(
    'notifier-cron',
    {},
    { repeat: { pattern: '30 13 * * *' } },
  );

  const notifierWorker = createWorker(QUEUE_NAMES.NOTIFIER, async (job) => {
    await processNotifierCronJob(
      job,
      dataSource,
      literacyLessonService,
      mediaMetaDataService,
    );
  });
  notifierWorker.on('failed', (job, err) =>
    logger.error(
      `worker(${QUEUE_NAMES.NOTIFIER}) FAILED job id=${job?.id} err=${err.message}`,
    ),
  );
  notifierWorker.on('error', (err) =>
    logger.error(`worker(${QUEUE_NAMES.NOTIFIER}) ERROR ${err.message}`),
  );

  // createWorker (not raw Worker) so instrumentWorker emits pp.bullmq.*
  // metrics — the raw construction left this queue invisible in Prometheus.
  // HIGH-tier sizing (WhatsApp 1,000 mps): ~3 messages per notification job,
  // limiter 100 jobs/s ≈ 300 mps; the binding constraint at this rate is
  // wabot's single instance, not Meta. Concurrency ≈ rate × ~2.5s job
  // latency (sequential per-item Graph calls).
  const notifierSendWorker = createWorker<NotifierSendJobData>(
    QUEUE_NAMES.NOTIFIER_SEND,
    async (job) => {
      await processNotifierSendJob(job, wabotOutbound, outboundMessageService);
    },
    {
      concurrency: 256,
      limiter: { max: 100, duration: 1000 },
    },
  );
  notifierSendWorker.on('failed', (job, err) =>
    logger.error(
      `worker(${QUEUE_NAMES.NOTIFIER_SEND}) FAILED job id=${job?.id} err=${err.message}`,
    ),
  );
  notifierSendWorker.on('error', (err) =>
    logger.error(`worker(${QUEUE_NAMES.NOTIFIER_SEND}) ERROR ${err.message}`),
  );

  // Morning-update cron: fires daily at 01:30 UTC = 07:00 IST.
  const reportCardService = app.get(ReportCardService);
  const morningUpdateQueue = createQueue(QUEUE_NAMES.MORNING_UPDATE);
  await morningUpdateQueue.add(
    'morning-update-cron',
    {},
    { repeat: { pattern: '30 1 * * *' } },
  );

  const morningUpdateWorker = createWorker(
    QUEUE_NAMES.MORNING_UPDATE,
    async (job) => {
      await processMorningUpdateCronJob(job, dataSource, mediaMetaDataService);
    },
  );
  morningUpdateWorker.on('failed', (job, err) =>
    logger.error(
      `worker(${QUEUE_NAMES.MORNING_UPDATE}) FAILED job id=${job?.id} err=${err.message}`,
    ),
  );
  morningUpdateWorker.on('error', (err) =>
    logger.error(`worker(${QUEUE_NAMES.MORNING_UPDATE}) ERROR ${err.message}`),
  );

  // createWorker for pp.bullmq.* metrics (was a raw Worker — invisible in
  // Prometheus, which is how the Jul-3 requeue storm went unmetered).
  // HIGH-tier sizing: limiter 100 jobs/s ≈ 300 mps of sends; the binding
  // constraint is CPU — ~0.2s sharp render/job caps ~120/s on 24 vCPU.
  // Concurrency ≈ rate × ~1.7s job latency (queries + render + send).
  const morningUpdateSendWorker = createWorker<MorningUpdateSendJobData>(
    QUEUE_NAMES.MORNING_UPDATE_SEND,
    async (job) => {
      await processMorningUpdateSendJob(
        job,
        reportCardService,
        mediaMetaDataService,
        mediaRepo,
        wabotOutbound,
        outboundMessageService,
      );
    },
    {
      concurrency: 128,
      limiter: { max: 100, duration: 1000 },
    },
  );
  morningUpdateSendWorker.on('failed', (job, err) =>
    logger.error(
      `worker(${QUEUE_NAMES.MORNING_UPDATE_SEND}) FAILED job id=${job?.id} err=${err.message}`,
    ),
  );
  morningUpdateSendWorker.on('error', (err) =>
    logger.error(
      `worker(${QUEUE_NAMES.MORNING_UPDATE_SEND}) ERROR ${err.message}`,
    ),
  );

  // Arrivals self-spread (each job fires 23h55m after that user's own last
  // message) so there is no herd; 32 just absorbs coincidental bursts.
  const hailMaryWorker = createWorker<HailMaryJobData>(
    QUEUE_NAMES.HAIL_MARY,
    async (job) => {
      await processHailMaryJob(
        job,
        dataSource,
        userService,
        mediaMetaDataService,
        literacyLessonService,
        wabotOutbound,
        outboundMessageService,
      );
    },
    { concurrency: 32 },
  );
  hailMaryWorker.on('failed', (job, err) =>
    logger.error(
      `worker(${QUEUE_NAMES.HAIL_MARY}) FAILED job id=${job?.id} err=${err.message}`,
    ),
  );
  hailMaryWorker.on('error', (err) =>
    logger.error(`worker(${QUEUE_NAMES.HAIL_MARY}) ERROR ${err.message}`),
  );

  // Media reload sweep: hourly DB scan replacing the old per-media chained
  // reload jobs. Re-uploads media whose WhatsApp id is >20 days old (ids
  // expire ~30d) and rescues rows stranded mid-first-upload.
  const mediaReloadSweepQueue = createQueue(QUEUE_NAMES.MEDIA_RELOAD_SWEEP);
  await mediaReloadSweepQueue.add(
    'media-reload-sweep-cron',
    {},
    { repeat: { pattern: '0 * * * *' } },
  );

  const mediaReloadSweepWorker = createWorker(
    QUEUE_NAMES.MEDIA_RELOAD_SWEEP,
    async (job) => {
      await processMediaReloadSweepJob(job, dataSource);
    },
  );
  mediaReloadSweepWorker.on('failed', (job, err) =>
    logger.error(
      `worker(${QUEUE_NAMES.MEDIA_RELOAD_SWEEP}) FAILED job id=${job?.id} err=${err.message}`,
    ),
  );
  mediaReloadSweepWorker.on('error', (err) =>
    logger.error(
      `worker(${QUEUE_NAMES.MEDIA_RELOAD_SWEEP}) ERROR ${err.message}`,
    ),
  );

  logger.log('BullMQ workers started for all 11 queues');

  await app.listen(process.env.PORT ?? 3000);
  logger.log(`Application listening on port ${process.env.PORT ?? 3000}`);
}
bootstrap();
