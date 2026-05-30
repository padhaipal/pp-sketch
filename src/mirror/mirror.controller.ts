import { ConflictException, Controller, HttpCode, Post } from '@nestjs/common';
import { MirrorService } from './mirror.service';

@Controller('admin/mirror')
export class MirrorController {
  constructor(private readonly mirrorService: MirrorService) {}

  @Post()
  @HttpCode(202)
  async trigger(): Promise<{ status: 'enqueued' }> {
    const result = await this.mirrorService.enqueue();
    if (result === 'already-running') {
      throw new ConflictException('mirror already running');
    }
    return { status: 'enqueued' };
  }
}
