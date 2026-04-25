import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { NUM_QUIZ_QUESTIONS, SubmitAnswerDto } from './quiz.dto';
import { QUIZ_PAGE_HTML } from './quiz-page.html';

@ApiTags('quiz')
@Controller('quiz')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return QUIZ_PAGE_HTML;
  }

  @Post('answer')
  async submitAnswer(@Body() body: SubmitAnswerDto): Promise<{ ok: true }> {
    await this.dashboardService.submitAnswer(body);
    return { ok: true };
  }

  @Get('answers')
  async getAnswers(
    @Query('question') question: string,
  ): Promise<{ answers: number[] }> {
    const idx = parseInt(question, 10);
    if (
      Number.isNaN(idx) ||
      idx < 0 ||
      idx >= NUM_QUIZ_QUESTIONS
    ) {
      throw new BadRequestException(
        `question must be 0..${NUM_QUIZ_QUESTIONS - 1}`,
      );
    }
    const answers = await this.dashboardService.getAnswersForQuestion(idx);
    return { answers };
  }

  @Get('stats')
  async getStats(): Promise<{ completed: number }> {
    const completed = await this.dashboardService.getCompletedSessionCount();
    return { completed };
  }
}