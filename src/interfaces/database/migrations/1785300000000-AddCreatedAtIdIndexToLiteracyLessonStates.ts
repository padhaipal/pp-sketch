import { MigrationInterface, QueryRunner } from 'typeorm';

// The interactions CSV export scans literacy_lesson_states by a global time
// window with (created_at, id) keyset pagination. The only existing index is
// (user_id, created_at), which cannot serve a cross-user time scan. Additive
// and backwards compatible.
export class AddCreatedAtIdIndexToLiteracyLessonStates1785300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_literacy_lesson_states_created_at_id"
       ON "literacy_lesson_states" ("created_at", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "idx_literacy_lesson_states_created_at_id"`,
    );
  }
}
