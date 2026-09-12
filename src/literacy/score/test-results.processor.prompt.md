# test-results.processor.ts — BullMQ processor for the `test-results` queue

`processTestResultsJob(job, service)`: one job = one
`TestResultsService.run({ full: job.data.full === true })`. A
`TestRunInProgressError` is logged and dropped (never retried — `attempts:
1`); anything else rethrows so the job fails visibly.

`TEST_RESULTS_CRON = '45 18 * * *'` (UTC) = 00:15 IST. main.ts adds the
repeatable `test-results-cron` job (`{ full: false }`) and registers the
worker (`concurrency: 1`) — pinned by test-results.registration.spec.ts,
which parses main.ts because the boot file is not unit-testable.
