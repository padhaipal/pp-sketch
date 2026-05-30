import { Module } from '@nestjs/common';
import { MediaBucketService } from './outbound.service';

@Module({
  providers: [MediaBucketService],
  exports: [MediaBucketService],
})
export class MediaBucketModule {}
