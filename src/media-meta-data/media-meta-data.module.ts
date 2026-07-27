import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaMetaDataEntity } from './media-meta-data.entity';
import { MediaMetaDataService } from './media-meta-data.service';
import { MediaMetadataCoverageService } from './media-metadata-coverage.service';
import { MediaMetaDataController } from './media-meta-data.controller';
import { UserModule } from '../users/user.module';
import { CacheService } from '../interfaces/redis/cache';
import { WabotOutboundService } from '../interfaces/wabot/outbound/outbound.service';
import { MediaBucketModule } from '../interfaces/media-bucket/outbound/outbound.module';
import { SarvamService } from '../interfaces/stt/sarvam/sarvam.service';
import { AzureService } from '../interfaces/stt/azure/azure.service';
import { ReverieService } from '../interfaces/stt/reverie/reverie.service';
import { OpenaiLlmService } from '../interfaces/llm/openai/openai-llm.service';
import { AnthropicLlmService } from '../interfaces/llm/anthropic/anthropic-llm.service';
import { GoogleLlmService } from '../interfaces/llm/google/google-llm.service';
import { MistralLlmService } from '../interfaces/llm/mistral/mistral-llm.service';
import { SarvamLlmService } from '../interfaces/llm/sarvam/sarvam-llm.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([MediaMetaDataEntity]),
    UserModule,
    MediaBucketModule,
  ],
  controllers: [MediaMetaDataController],
  providers: [
    MediaMetaDataService,
    MediaMetadataCoverageService,
    CacheService,
    WabotOutboundService,
    SarvamService,
    AzureService,
    ReverieService,
    OpenaiLlmService,
    AnthropicLlmService,
    GoogleLlmService,
    MistralLlmService,
    SarvamLlmService,
  ],
  exports: [MediaMetaDataService, TypeOrmModule],
})
export class MediaMetaDataModule {}
