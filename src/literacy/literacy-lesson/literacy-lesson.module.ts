import { Module } from '@nestjs/common';
import { LiteracyLessonService } from './literacy-lesson.service';
import { ScoreModule } from '../score/score.module';

@Module({
  imports: [ScoreModule],
  providers: [LiteracyLessonService],
  exports: [LiteracyLessonService],
})
export class LiteracyLessonModule {}
