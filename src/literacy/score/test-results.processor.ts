import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  TestResultsService,
  TestRunInProgressError,
} from './test-results.service';

const logger = new Logger('TestResultsProcessor');

// 18:45 UTC = 00:15 IST — after the day's last lesson turns, before the
// 07:00 IST morning update reads anything.
export const TEST_RESULTS_CRON = '45 18 * * *';

export interface TestResultsJobData {
  full?: boolean;
}

// One job = one run. The service owns the overlap guard: a run already in
// progress is logged and dropped, never retried (attempts: 1 in queues.ts).
export async function processTestResultsJob(
  job: Job<TestResultsJobData>,
  service: TestResultsService,
): Promise<void> {
  const full = job.data?.full === true;
  try {
    const summary = await service.run({ full });
    logger.log(
      `job ${job.id ?? '?'}: run ${summary.runId} ok — computed_for=${summary.computedFor} candidates=${summary.candidates} scored=${summary.scored} geo_rows=${summary.geoRows}`,
    );
  } catch (err) {
    if (err instanceof TestRunInProgressError) {
      logger.warn(`job ${job.id ?? '?'}: skipped — ${err.message}`);
      return;
    }
    throw err;
  }
}
