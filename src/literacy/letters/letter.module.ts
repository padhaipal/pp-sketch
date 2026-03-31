import { Module } from '@nestjs/common';
import { LetterService } from './letter.service';

@Module({
  providers: [LetterService],
  exports: [LetterService],
})
export class LetterModule {}
