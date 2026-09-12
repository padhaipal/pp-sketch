import {
  ConflictException,
  Controller,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { TestResultsService } from './test-results.service';

// Manual trigger, same shape as POST /admin/mirror: enqueues a job and
// returns 202, 409 while a run is live. No pp-sketch-side auth — reachable
// only through the pp-dashboard proxy, whose admin allowlist excludes
// admin/*, so dev role only.
@Controller('admin/test-results')
export class TestResultsController {
  constructor(private readonly testResultsService: TestResultsService) {}

  @Post('run')
  @HttpCode(202)
  async run(
    @Query('full') full?: string,
  ): Promise<{ status: 'enqueued'; full: boolean }> {
    const isFull = full === 'true' || full === '1';
    const result = await this.testResultsService.enqueue(isFull);
    if (result === 'already-running') {
      throw new ConflictException('test-results run already in progress');
    }
    return { status: 'enqueued', full: isFull };
  }
}
