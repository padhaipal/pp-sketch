import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppDataSource } from './interfaces/database/data-source';
import { UserModule } from './users/user.module';
import { MediaMetaDataModule } from './media-meta-data/media-meta-data.module';
import { LiteracyLessonModule } from './literacy/literacy-lesson/literacy-lesson.module';
import { LetterModule } from './literacy/letters/letter.module';
import { ScoreModule } from './literacy/score/score.module';
import { DashboardModule } from './interfaces/dashboard/dashboard.module';
import { HealthController } from './health/health.controller';
import { WabotInboundController } from './interfaces/wabot/inbound/inbound.controller';
import { HeygenInboundController } from './interfaces/heygen/inbound/inbound.controller';
import { CacheService } from './interfaces/redis/cache';

@Module({
  imports: [
    TypeOrmModule.forRoot(AppDataSource.options),
    UserModule,
    MediaMetaDataModule,
    LiteracyLessonModule,
    LetterModule,
    ScoreModule,
    DashboardModule,
  ],
  controllers: [
    AppController,
    HealthController,
    WabotInboundController,
    HeygenInboundController,
  ],
  providers: [AppService, CacheService],
})
export class AppModule {}
