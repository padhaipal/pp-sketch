import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAnswerCorrectToLiteracyLessonStates1776276400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" ADD COLUMN "answer_correct" boolean`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" DROP COLUMN "answer_correct"`,
    );
  }
}
