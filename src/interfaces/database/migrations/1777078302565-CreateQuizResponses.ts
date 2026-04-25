import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateQuizResponses1777078302565 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "quiz_responses" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "session_id" uuid NOT NULL,
         "question_index" int NOT NULL,
         "answer" double precision NOT NULL,
         "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_quiz_responses" PRIMARY KEY ("id"),
         CONSTRAINT "uq_quiz_responses_session_question" UNIQUE ("session_id", "question_index")
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_quiz_responses_session_id" ON "quiz_responses" ("session_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_quiz_responses_session_id"`);
    await queryRunner.query(`DROP TABLE "quiz_responses"`);
  }
}