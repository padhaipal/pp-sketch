import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ScoreService } from './score.service';
import { LetterBinsResult, LetterBinsQueryDto } from './score.dto';

@ApiTags('scores')
@Controller('scores')
export class ScoreController {
  constructor(private readonly scoreService: ScoreService) {}

  @Get('letter-bins')
  async letterBins(
    @Query() query: LetterBinsQueryDto,
  ): Promise<LetterBinsResult[]> {
    return this.scoreService.getLetterBins(query.users) as Promise<
      LetterBinsResult[]
    >;
  }
}