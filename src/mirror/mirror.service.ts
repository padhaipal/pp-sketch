import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createQueue, QUEUE_NAMES } from '../interfaces/redis/queues';

const SINGLETON_JOB_ID = 'mirror-singleton';

export type EnqueueResult = 'enqueued' | 'already-running';

@Injectable()
export class MirrorService implements OnModuleDestroy {
  private readonly logger = new Logger('MirrorService');
  private readonly queue: Queue;

  constructor() {
    this.queue = createQueue(QUEUE_NAMES.MIRROR);
  }

  async enqueue(): Promise<EnqueueResult> {
    const existing = await this.queue.getJob(SINGLETON_JOB_ID);
    if (existing) {
      const state = await existing.getState();
      if (state === 'active' || state === 'waiting' || state === 'delayed') {
        this.logger.log(`mirror.enqueue.already-running state=${state}`);
        return 'already-running';
      }
      // completed | failed | unknown — remove so add() doesn't dedupe.
      await existing.remove();
    }
    await this.queue.add('mirror', {}, { jobId: SINGLETON_JOB_ID });
    this.logger.log('mirror.enqueue.enqueued');
    return 'enqueued';
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => {});
  }
}
