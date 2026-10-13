import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  TestResultStudentEntity,
  TestResultGeoEntityEntity,
  TestRunEntity,
} from './test-results.entity';
import { TestResultsService } from './test-results.service';
import { TestResultsController } from './test-results.controller';
import { DashboardScoresService } from './dashboard-scores.service';
import { DashboardScoresController } from './dashboard-scores.controller';
import { GeoEntityModule } from '../../geo-entities/geo-entity.module';
import { PiiAccessModule } from '../../users/pii-access.module';
import { ShareMessageService } from './share-message.service';
import { CacheService } from '../../interfaces/redis/cache';
import { AnthropicLlmService } from '../../interfaces/llm/anthropic/anthropic-llm.service';
import { OpenaiLlmService } from '../../interfaces/llm/openai/openai-llm.service';
import { MistralLlmService } from '../../interfaces/llm/mistral/mistral-llm.service';
import { SarvamLlmService } from '../../interfaces/llm/sarvam/sarvam-llm.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TestResultStudentEntity,
      TestResultGeoEntityEntity,
      TestRunEntity,
    ]),
    GeoEntityModule,
    PiiAccessModule,
  ],
  controllers: [TestResultsController, DashboardScoresController],
  providers: [
    TestResultsService,
    DashboardScoresService,
    // The share message (an LLM call per page load): the pure API clients
    // (never Google — reserved for the onboarding classifier) + the cache
    // for its per-viewer rate limit.
    ShareMessageService,
    CacheService,
    AnthropicLlmService,
    OpenaiLlmService,
    MistralLlmService,
    SarvamLlmService,
  ],
  exports: [TestResultsService, DashboardScoresService],
})
export class TestResultsModule {}
