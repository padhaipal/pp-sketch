import { Module, NestModule, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { json } from 'express';
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
export class MediaMetaDataModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Bulk audio-generation batches can be many MB; override the default 100kb body limit on these routes only.
    consumer
      .apply(json({ limit: '5mb' }))
      .forRoutes(
        { path: 'media-meta-data/elevenlabs-generate', method: RequestMethod.POST },
        { path: 'media-meta-data/heygen-generate', method: RequestMethod.POST },
      );
  }
}
