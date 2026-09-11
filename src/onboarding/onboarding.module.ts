import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OnboardingStateEntity } from './onboarding-state.entity';
import { OnboardingService } from './onboarding.service';
import { UserModule } from '../users/user.module';
import { LiteracyLessonModule } from '../literacy/literacy-lesson/literacy-lesson.module';
import { OpenaiLlmService } from '../interfaces/llm/openai/openai-llm.service';
import { AnthropicLlmService } from '../interfaces/llm/anthropic/anthropic-llm.service';
import { GoogleLlmService } from '../interfaces/llm/google/google-llm.service';
import { MistralLlmService } from '../interfaces/llm/mistral/mistral-llm.service';
import { SarvamLlmService } from '../interfaces/llm/sarvam/sarvam-llm.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([OnboardingStateEntity]),
    UserModule,
    LiteracyLessonModule,
  ],
  providers: [
    OnboardingService,
    OpenaiLlmService,
    AnthropicLlmService,
    GoogleLlmService,
    MistralLlmService,
    SarvamLlmService,
  ],
  exports: [OnboardingService],
})
export class OnboardingModule {}
