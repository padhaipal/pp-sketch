import { Module } from '@nestjs/common';
import { LetterService } from './letter.service';
import { LetterController } from './letter.controller';

@Module({
  controllers: [LetterController],
  providers: [LetterService],
  exports: [LetterService],
})
export class LetterModule {}
