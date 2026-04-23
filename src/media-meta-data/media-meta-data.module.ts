import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaMetaDataEntity } from './media-meta-data.entity';
import { MediaMetaDataService } from './media-meta-data.service';
import { MediaMetadataCoverageService } from './media-metadata-coverage.service';
import { MediaMetaDataController } from './media-meta-data.controller';
import { UserModule } from '../users/user.module';
import { CacheService } from '../interfaces/redis/cache';
import { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';
import { MediaBucketService } from '../interfaces/media-bucket/outbound/outbound.service';
import { SarvamService } from '../interfaces/stt/sarvam/sarvam.service';
import { AzureService } from '../interfaces/stt/azure/azure.service';
import { ReverieService } from '../interfaces/stt/reverie/reverie.service';

@Module({
  imports: [TypeOrmModule.forFeature([MediaMetaDataEntity]), UserModule],
  controllers: [MediaMetaDataController],
  providers: [
    MediaMetaDataService,
    MediaMetadataCoverageService,
    CacheService,
    WabotOutboundService,
    MediaBucketService,
    SarvamService,
    AzureService,
    ReverieService,
  ],
  exports: [MediaMetaDataService, TypeOrmModule],
})
export class MediaMetaDataModule {}
