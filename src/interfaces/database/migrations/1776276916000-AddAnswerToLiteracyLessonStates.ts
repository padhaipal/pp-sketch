import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAnswerToLiteracyLessonStates1776276916000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" ADD COLUMN "answer" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" DROP COLUMN "answer"`,
    );
  }
}
