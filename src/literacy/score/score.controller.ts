import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ScoreService } from './score.service';
import { LettersLearntResult, LettersLearntQueryDto } from './score.dto';

@ApiTags('scores')
@Controller('scores')
export class ScoreController {
  constructor(private readonly scoreService: ScoreService) {}

  @Get('letters-learnt')
  async lettersLearnt(
    @Query() query: LettersLearntQueryDto,
  ): Promise<LettersLearntResult[]> {
    return this.scoreService.getLettersLearnt(query.users) as Promise<LettersLearntResult[]>;
  }
}
