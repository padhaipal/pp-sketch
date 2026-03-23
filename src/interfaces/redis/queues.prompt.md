// pp-sketch/src/redis/queues.prompt.md

Export queue names, Redis connection, and Queue/Worker factories.

1.) QUEUE_NAMES constant.
* WABOT_INBOUND: 'wabot-inbound'.
* HEYGEN_GENERATE: 'heygen-generate'.
* HEYGEN_INBOUND: 'heygen-inbound'.
* WHATSAPP_PRELOAD: 'whatsapp-preload'.

2.) Redis connection.
* Create ioredis Connection from REDIS_URL (.env).
* Use for BullMQ Queue and Worker instances.

3.) createQueue(name, defaultJobOptions?).
* Returns BullMQ Queue instance.

4.) createWorker(name, processor, defaultJobOptions?).
* Returns BullMQ Worker instance.
* Workers must be started on app bootstrap (see main.prompt.md).
