import { ConflictException } from '@nestjs/common';
import { TestResultsController } from './test-results.controller';
import type { TestResultsService } from './test-results.service';

function make(result: 'enqueued' | 'already-running') {
  const enqueue = jest.fn().mockResolvedValue(result);
  return {
    ctrl: new TestResultsController({
      enqueue,
    } as unknown as TestResultsService),
    enqueue,
  };
}

describe('POST /admin/test-results/run', () => {
  it('enqueues with full parsed from the query string', async () => {
    const { ctrl, enqueue } = make('enqueued');
    await expect(ctrl.run(undefined)).resolves.toEqual({
      status: 'enqueued',
      full: false,
    });
    expect(enqueue).toHaveBeenLastCalledWith(false);
    await expect(ctrl.run('true')).resolves.toEqual({
      status: 'enqueued',
      full: true,
    });
    expect(enqueue).toHaveBeenLastCalledWith(true);
    await ctrl.run('1');
    expect(enqueue).toHaveBeenLastCalledWith(true);
    await ctrl.run('yes');
    expect(enqueue).toHaveBeenLastCalledWith(false);
  });

  it('409s while a run is in progress', async () => {
    const { ctrl } = make('already-running');
    await expect(ctrl.run('true')).rejects.toThrow(ConflictException);
  });
});
