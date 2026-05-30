import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './user.entity';
import { MediaMetaDataEntity } from '../media-meta-data/media-meta-data.entity';
import { ScoreEntity } from '../literacy/score/score.entity';
import { LiteracyLessonStateEntity } from '../literacy/literacy-lesson/literacy-lesson-state.entity';
import { UserService } from './user.service';
import { UserActivityService } from './user-activity.service';
import { UserController } from './user.controller';
import { CacheService } from '../interfaces/redis/cache';
import { ScoreModule } from '../literacy/score/score.module';
import { MediaBucketModule } from '../interfaces/media-bucket/outbound/outbound.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      MediaMetaDataEntity,
      ScoreEntity,
      LiteracyLessonStateEntity,
    ]),
    ScoreModule,
    MediaBucketModule,
  ],
  controllers: [UserController],
  providers: [UserService, UserActivityService, CacheService],
  exports: [UserService, UserActivityService],
})
export class UserModule {}
