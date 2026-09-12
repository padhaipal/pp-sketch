import * as fs from 'fs';
import * as path from 'path';

// main.ts is coverage-ignored and boots the whole app, so the only way to
// pin "the worker is actually registered" (the miss CLAUDE.md warns about —
// a BullMQ worker that was never wired up) is to read the source.
const SRC = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('test-results worker registration', () => {
  const main = read('main.ts');

  it('main.ts creates the worker for QUEUE_NAMES.TEST_RESULTS with processTestResultsJob', () => {
    expect(main).toMatch(
      /createWorker<TestResultsJobData>\(\s*QUEUE_NAMES\.TEST_RESULTS,[\s\S]*?processTestResultsJob\(job, testResultsService\)/,
    );
  });

  it('main.ts schedules the nightly repeatable job on TEST_RESULTS_CRON', () => {
    expect(main).toMatch(/createQueue\(QUEUE_NAMES\.TEST_RESULTS\)/);
    expect(main).toMatch(
      /'test-results-cron',\s*\{ full: false \},\s*\{ repeat: \{ pattern: TEST_RESULTS_CRON \} \}/,
    );
    expect(main).toMatch(/BullMQ workers started for all 12 queues/);
  });

  it('queues.ts declares the queue with a single attempt', () => {
    const queues = read('interfaces/redis/queues.ts');
    expect(queues).toMatch(/TEST_RESULTS: 'test-results'/);
    expect(queues).toMatch(/\[QUEUE_NAMES\.TEST_RESULTS\]: \{\s*attempts: 1,/);
  });

  it('AppModule imports TestResultsModule and the data source registers the three entities', () => {
    expect(read('app.module.ts')).toMatch(/TestResultsModule,/);
    const ds = read('interfaces/database/data-source.ts');
    for (const entity of [
      'TestResultStudentEntity',
      'TestResultGeoEntityEntity',
      'TestRunEntity',
    ]) {
      expect(ds).toMatch(new RegExp(`${entity},`));
    }
  });
});
