import {
  Controller,
  Get,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ScoreService } from './score.service';
import { LettersLearntResult } from './score.dto';

@ApiTags('scores')
@Controller('scores')
export class ScoreController {
  constructor(private readonly scoreService: ScoreService) {}

  @Get('letters-learnt')
  async lettersLearnt(
    @Query('users') users?: string | string[],
  ): Promise<LettersLearntResult | LettersLearntResult[]> {
    if (!users) {
      throw new BadRequestException('users query parameter is required');
    }

    let parts: string[];
    if (typeof users === 'string') {
      parts = users
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      parts = users.flatMap((s) =>
        s
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
      );
    }

    if (parts.length === 0) {
      throw new BadRequestException(
        'users query parameter must contain at least one user',
      );
    }

    if (parts.length === 1) {
      return this.scoreService.getLettersLearnt(parts[0]);
    }
    return this.scoreService.getLettersLearnt(parts);
  }
}
