import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  NUM_QUIZ_QUESTIONS,
  ShareData,
  SubmitAnswerDto,
  SubscribeDto,
} from './quiz.dto';

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

  async subscribeEmail(input: SubscribeDto): Promise<void> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const trimmedName = input.name?.trim();
    const name = trimmedName && trimmedName.length > 0 ? trimmedName : null;
    await this.dataSource.query(
      `INSERT INTO mailing_list_entries (email, name)
       VALUES ($1, $2)
       ON CONFLICT ON CONSTRAINT uq_mailing_list_entries_email
       DO UPDATE SET name = COALESCE(EXCLUDED.name, mailing_list_entries.name)`,
      [normalizedEmail, name],
    );
  }

  async getMailingListSubscribers(): Promise<
    { email: string; name: string | null; created_at: Date }[]
  > {
    const rows: { email: string; name: string | null; created_at: Date }[] =
      await this.dataSource.query(
        `SELECT email, name, created_at
         FROM mailing_list_entries
         ORDER BY created_at DESC`,
      );
    return rows;
  }

  async createOrGetShareToken(sessionId: string): Promise<string> {
    // Idempotent: one token per session_id (enforced by uq_quiz_share_tokens_session_id).
    const existing: { token: string }[] = await this.dataSource.query(
      `SELECT token FROM quiz_share_tokens WHERE session_id = $1`,
      [sessionId],
    );
    if (existing.length > 0) return existing[0].token;

    // ~12 chars, URL-safe, ~71 bits of entropy. Loop on the unlikely collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = randomBytes(9).toString('base64url');
      try {
        await this.dataSource.query(
          `INSERT INTO quiz_share_tokens (token, session_id) VALUES ($1, $2)`,
          [token, sessionId],
        );
        return token;
      } catch (err) {
        // Could be (a) PK collision on token (re-roll), or (b) unique violation on session_id
        // (concurrent insert by same session — fetch and return the winner).
        const code = (err as { code?: string }).code;
        if (code !== '23505') throw err;
        const winner: { token: string }[] = await this.dataSource.query(
          `SELECT token FROM quiz_share_tokens WHERE session_id = $1`,
          [sessionId],
        );
        if (winner.length > 0) return winner[0].token;
        // else token PK collision — retry
      }
    }
    throw new Error('failed to allocate share token after 5 attempts');
  }

  async getShareData(token: string): Promise<ShareData> {
    const sessionRows: { session_id: string }[] = await this.dataSource.query(
      `SELECT session_id FROM quiz_share_tokens WHERE token = $1`,
      [token],
    );
    if (sessionRows.length === 0) {
      throw new NotFoundException('share token not found');
    }
    const sessionId = sessionRows[0].session_id;

    const [answers, completed] = await Promise.all([
      this.dataSource.query(
        `SELECT question_index, answer FROM quiz_responses WHERE session_id = $1 ORDER BY question_index`,
        [sessionId],
      ) as Promise<{ question_index: number; answer: number }[]>,
      this.getCompletedSessionCount(),
    ]);

    return {
      answers: answers.map((a) => ({
        question_index: a.question_index,
        answer: Number(a.answer),
      })),
      completed,
    };
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