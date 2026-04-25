import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateQuizShareTokens1777082644417 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // The UNIQUE constraint on session_id implicitly creates a btree index
    // that serves all WHERE session_id = $1 lookups; no separate index needed.
    await queryRunner.query(
      `CREATE TABLE "quiz_share_tokens" (
         "token" text NOT NULL,
         "session_id" uuid NOT NULL,
         "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_quiz_share_tokens" PRIMARY KEY ("token"),
         CONSTRAINT "uq_quiz_share_tokens_session_id" UNIQUE ("session_id")
       )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "quiz_share_tokens"`);
  }
}