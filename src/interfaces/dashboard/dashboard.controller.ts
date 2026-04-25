import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import {
  NUM_QUIZ_QUESTIONS,
  SubmitAnswerDto,
  SubscribeDto,
} from './quiz.dto';

@ApiTags('quiz')
@Controller('quiz')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Post('answer')
  async submitAnswer(@Body() body: SubmitAnswerDto): Promise<{ ok: true }> {
    await this.dashboardService.submitAnswer(body);
    return { ok: true };
  }

  @Get('answers')
  async getAnswers(
    @Query('question') question: string,
    @Query('exclude_session') excludeSession?: string,
  ): Promise<{ answers: number[] }> {
    const idx = parseInt(question, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= NUM_QUIZ_QUESTIONS) {
      throw new BadRequestException(
        `question must be 0..${NUM_QUIZ_QUESTIONS - 1}`,
      );
    }
    const exclude =
      excludeSession &&
      /^[0-9a-f-]{36}$/i.test(excludeSession)
        ? excludeSession
        : undefined;
    const answers = await this.dashboardService.getAnswersForQuestion(
      idx,
      exclude,
    );
    return { answers };
  }

  @Get('stats')
  async getStats(): Promise<{ completed: number }> {
    const completed = await this.dashboardService.getCompletedSessionCount();
    return { completed };
  }

  @Post('subscribe')
  async subscribe(@Body() body: SubscribeDto): Promise<{ ok: true }> {
    await this.dashboardService.subscribeEmail(body);
    return { ok: true };
  }
}