import {
  DynamicModule,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import { createWorker, QUEUE_NAMES } from '../interfaces/redis/queues';
import { MirrorController } from './mirror.controller';
import { MirrorService } from './mirror.service';
import { MirrorProcessor } from './mirror.processor';

// Deviation from main.ts-instantiated-Worker pattern: MirrorModule owns its
// Worker via OnModuleInit so the controller-route registration and the queue
// consumer share a single NODE_ENV gate. If main.ts registered the worker,
// the controller could exist without a consumer (job queued, never run) or
// vice versa.
@Module({})
export class MirrorModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MirrorModule');
  private worker?: Worker;

  static register(): DynamicModule {
    if (process.env.NODE_ENV === 'production') {
      // Prod: no controller, no service, no worker. Endpoint literally does
      // not exist on prod containers.
      return { module: MirrorModule };
    }
    return {
      module: MirrorModule,
      controllers: [MirrorController],
      providers: [MirrorService, MirrorProcessor],
    };
  }

  constructor(@Optional() private readonly processor?: MirrorProcessor) {}

  onModuleInit(): void {
    if (!this.processor) {
      this.logger.log('mirror disabled (NODE_ENV=production)');
      return;
    }
    this.worker = createWorker(QUEUE_NAMES.MIRROR, async (job) => {
      await this.processor!.run(job);
    });
    this.worker.on('failed', (job, err) =>
      this.logger.error(
        `worker(${QUEUE_NAMES.MIRROR}) FAILED job id=${job?.id} err=${err.message}`,
      ),
    );
    this.worker.on('error', (err) =>
      this.logger.error(`worker(${QUEUE_NAMES.MIRROR}) ERROR ${err.message}`),
    );
    this.logger.log(`worker(${QUEUE_NAMES.MIRROR}) started`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
