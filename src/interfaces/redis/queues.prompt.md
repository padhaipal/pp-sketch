// pp-sketch/src/interfaces/redis/queues.prompt.md

Export queue names, Redis connection, and Queue/Worker factories.

1.) QUEUE_NAMES constant.
* WABOT_INBOUND: 'wabot-inbound'.
* HEYGEN_GENERATE: 'heygen-generate'.
* HEYGEN_INBOUND: 'heygen-inbound'.
* ELEVENLABS_GENERATE: 'elevenlabs-generate'.
* WHATSAPP_PRELOAD: 'whatsapp-preload'.

2.) Redis connection.
* Create ioredis Connection from BULLMQ_REDIS_URL (.env).
* Use for BullMQ Queue and Worker instances.

3.) DEFAULT_JOB_OPTIONS per queue.
Each queue has its own defaultJobOptions controlling retry behaviour and Redis cleanup.
When a worker's processJob() throws (or the job is explicitly failed), BullMQ retries the job according to these settings.

* WABOT_INBOUND:
  - attempts: 3, backoff: { type: 'exponential', delay: 2000 }
  - removeOnComplete: true, removeOnFail: { count: 5000 }
  - Rationale: real-time interaction; processor discards messages older than 20 s, so retries must stay well under that window (~6 s total).

* HEYGEN_GENERATE:
  - attempts: 5, backoff: { type: 'exponential', delay: 5000 }
  - removeOnComplete: true, removeOnFail: { count: 5000 }
  - Rationale: external HeyGen API, async media generation. Gives the API ~75 s to recover from rate-limits or transient 5XX errors.

* HEYGEN_INBOUND:
  - attempts: 3, backoff: { type: 'exponential', delay: 5000 }
  - removeOnComplete: true, removeOnFail: { count: 5000 }
  - Rationale: webhook processing (download + S3 upload). Most processor failures are terminal (no retry); the retry budget covers unexpected transient failures (~15 s total).

* ELEVENLABS_GENERATE:
  - attempts: 5, backoff: { type: 'exponential', delay: 5000 }
  - removeOnComplete: true, removeOnFail: { count: 5000 }
  - Rationale: external ElevenLabs API, synchronous TTS. Same retry budget as HEYGEN_GENERATE (~75 s).

* WHATSAPP_PRELOAD:
  - attempts: 5, backoff: { type: 'exponential', delay: 10000 }
  - removeOnComplete: true, removeOnFail: { count: 5000 }
  - Rationale: S3 reads + WhatsApp Cloud API uploads, async preload. WhatsApp rate-limiting can last a while (~150 s total retry window).

4.) createQueue(name, defaultJobOptions?).
* Returns BullMQ Queue instance.
* If defaultJobOptions is omitted, uses the queue's DEFAULT_JOB_OPTIONS from (3).

5.) createWorker(name, processor, defaultJobOptions?).
* Returns BullMQ Worker instance.
* If defaultJobOptions is omitted, uses the queue's DEFAULT_JOB_OPTIONS from (3).
* Workers must be started on app bootstrap (see src/main.ts).
