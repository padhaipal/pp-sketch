import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NUM_QUIZ_QUESTIONS, SubmitAnswerDto } from './quiz.dto';

@Injectable()
export class DashboardService {
  constructor(private readonly dataSource: DataSource) {}

  async submitAnswer(input: SubmitAnswerDto): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO quiz_responses (session_id, question_index, answer)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT uq_quiz_responses_session_question
       DO UPDATE SET answer = EXCLUDED.answer`,
      [input.session_id, input.question_index, input.answer],
    );
  }

  async getAnswersForQuestion(
    questionIndex: number,
    excludeSession?: string,
  ): Promise<number[]> {
    const params: unknown[] = [questionIndex];
    let where = `question_index = $1`;
    if (excludeSession) {
      params.push(excludeSession);
      where += ` AND session_id <> $2`;
    }
    const rows: { answer: number }[] = await this.dataSource.query(
      `SELECT answer FROM quiz_responses WHERE ${where}`,
      params,
    );
    return rows.map((r) => Number(r.answer));
  }

  async getCompletedSessionCount(): Promise<number> {
    const rows: { count: string }[] = await this.dataSource.query(
      `SELECT COUNT(*)::text AS count FROM (
         SELECT session_id
         FROM quiz_responses
         GROUP BY session_id
         HAVING COUNT(*) = $1
       ) t`,
      [NUM_QUIZ_QUESTIONS],
    );
    return parseInt(rows[0]?.count ?? '0', 10);
  }
}