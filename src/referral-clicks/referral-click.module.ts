import { Module } from '@nestjs/common';
import { ReferralClickController } from './referral-click.controller';
import { ReferralClickService } from './referral-click.service';

@Module({
  controllers: [ReferralClickController],
  providers: [ReferralClickService],
})
export class ReferralClickModule {}
