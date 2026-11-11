import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ReferralClickService } from './referral-click.service';
import {
  RecordReferralClickDto,
  ReferralClickSummary,
} from './referral-click.dto';

// Behind the dashboard's API key (ApiKeyGuard); wabot's key cannot reach it.
@ApiTags('referral-clicks')
@Controller('referral-clicks')
export class ReferralClickController {
  constructor(private readonly service: ReferralClickService) {}

  @Post()
  @ApiOperation({ summary: 'Record one tap on a /r/<phone> referral link' })
  async record(@Body() body: RecordReferralClickDto): Promise<{ ok: true }> {
    await this.service.recordClick(body);
    return { ok: true };
  }

  @Get('summary')
  @ApiOperation({
    summary:
      'Referral link clicks per referrer, with distinct visitors and sign-ups',
  })
  @ApiQuery({ name: 'since', required: true, example: '2026-11-01' })
  async summary(@Query('since') since: string): Promise<ReferralClickSummary> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? '')) {
      throw new BadRequestException('since must be YYYY-MM-DD');
    }
    // Midnight IST, to match how the rest of the dashboard counts days.
    const date = new Date(`${since}T00:00:00+05:30`);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('since is not a valid date');
    }
    return this.service.summary(date);
  }
}
