import { MigrationInterface, QueryRunner } from 'typeorm';

// Passage-based sentence lessons: .word becomes nullable and .passage_id
// (FK → media_metadata.id, the reading-passage row) is added. A row must
// carry at least one of the two — word lessons keep .word, passage lessons
// set .passage_id (and .word still holds the joined sentence text for
// existing readers). Backwards compatible: no existing rows change shape.
export class AddPassageIdToLiteracyLessonStates1785200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" ALTER COLUMN "word" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" ADD COLUMN "passage_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states"
       ADD CONSTRAINT "fk_literacy_lesson_states_passage_id"
       FOREIGN KEY ("passage_id") REFERENCES "media_metadata"("id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states"
       ADD CONSTRAINT "chk_literacy_lesson_states_word_or_passage"
       CHECK ("word" IS NOT NULL OR "passage_id" IS NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_literacy_lesson_states_passage_id"
       ON "literacy_lesson_states" ("passage_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "idx_literacy_lesson_states_passage_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states"
       DROP CONSTRAINT "chk_literacy_lesson_states_word_or_passage"`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states"
       DROP CONSTRAINT "fk_literacy_lesson_states_passage_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" DROP COLUMN "passage_id"`,
    );
    await queryRunner.query(
      `UPDATE "literacy_lesson_states" SET "word" = '' WHERE "word" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" ALTER COLUMN "word" SET NOT NULL`,
    );
  }
}
