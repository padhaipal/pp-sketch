import {
  IsEmail,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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

export class SubscribeDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}