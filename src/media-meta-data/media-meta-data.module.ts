import { Module } from '@nestjs/common';
import { MediaMetaDataService } from './media-meta-data.service';
import { MediaMetaDataController } from './media-meta-data.controller';
import { UserModule } from '../users/user.module';
import { CacheService } from '../interfaces/redis/cache';
import { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';
import { MediaBucketService } from '../interfaces/media-bucket/outbound/outbound.service';
import { SarvamService } from '../interfaces/stt/sarvam/sarvam.service';
import { AzureService } from '../interfaces/stt/azure/azure.service';
import { ReverieService } from '../interfaces/stt/reverie/reverie.service';

@Module({
  imports: [UserModule],
  controllers: [MediaMetaDataController],
  providers: [
    MediaMetaDataService,
    CacheService,
    WabotOutboundService,
    MediaBucketService,
    SarvamService,
    AzureService,
    ReverieService,
  ],
  exports: [MediaMetaDataService],
})
export class MediaMetaDataModule {}
