import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LiteracyLessonStateEntity } from './literacy-lesson-state.entity';
import { LiteracyLessonService } from './literacy-lesson.service';
import { ScoreModule } from '../score/score.module';
import { AserService } from '../aser/aser.service';

@Module({
  imports: [TypeOrmModule.forFeature([LiteracyLessonStateEntity]), ScoreModule],
  providers: [LiteracyLessonService, AserService],
  exports: [LiteracyLessonService],
})
export class LiteracyLessonModule {}
