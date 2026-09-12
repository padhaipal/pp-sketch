import { Logger } from '@nestjs/common';
import {
  processTestResultsJob,
  TEST_RESULTS_CRON,
} from './test-results.processor';
import {
  TestResultsService,
  TestRunInProgressError,
} from './test-results.service';

describe('processTestResultsJob', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it("runs with the job's full flag (default false)", async () => {
    const run = jest.fn().mockResolvedValue({
      runId: 'r',
      computedFor: '2026-09-13',
      full: false,
      candidates: 1,
      scored: 1,
      geoRows: 2,
    });
    const svc = { run } as unknown as TestResultsService;
    await processTestResultsJob({ id: '1', data: {} } as never, svc);
    expect(run).toHaveBeenCalledWith({ full: false });
    await processTestResultsJob(
      { id: '2', data: { full: true } } as never,
      svc,
    );
    expect(run).toHaveBeenLastCalledWith({ full: true });
  });

  it('drops (warns, does not throw) when a run is already in progress, rethrows anything else', async () => {
    const run = jest
      .fn()
      .mockRejectedValueOnce(new TestRunInProgressError('run-9'))
      .mockRejectedValueOnce(new Error('db down'));
    const svc = { run } as unknown as TestResultsService;
    await expect(
      processTestResultsJob({ id: '1', data: {} } as never, svc),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/skipped — .*run-9/),
    );
    await expect(
      processTestResultsJob({ id: '2', data: {} } as never, svc),
    ).rejects.toThrow('db down');
  });

  it('is scheduled at 18:45 UTC = 00:15 IST', () => {
    expect(TEST_RESULTS_CRON).toBe('45 18 * * *');
  });
});
