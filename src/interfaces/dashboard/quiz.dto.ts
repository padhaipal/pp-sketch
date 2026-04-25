import { IsInt, IsNumber, IsUUID, Max, Min } from 'class-validator';

export const NUM_QUIZ_QUESTIONS = 5;

export class SubmitAnswerDto {
  @IsUUID()
  session_id: string;

  @IsInt()
  @Min(0)
  @Max(NUM_QUIZ_QUESTIONS - 1)
  question_index: number;

  @IsNumber()
  answer: number;
}