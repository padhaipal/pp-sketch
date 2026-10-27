import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { TractionService } from './traction.service';

const logger = new Logger('TractionWarmProcessor');

// 20:00 UTC = 01:30 IST: after the 00:15 IST nightly test results (whose
// rows feed the MPL-B line), long before anyone in India is awake.
export const TRACTION_WARM_CRON = '0 20 * * *';

// One job = recompute today's traction series and overwrite its cache key
// (traction.service.ts), so a visitor never waits on the computation.
// Never retried (attempts: 1 in queues.ts): a miss is recomputed on the
// first request instead.
export async function processTractionWarmJob(
  job: Job,
  service: TractionService,
): Promise<void> {
  const out = await service.refresh();
  logger.log(
    `job ${job.id ?? '?'}: traction warmed — days=${out.daily.length} to=${out.to}`,
  );
}
