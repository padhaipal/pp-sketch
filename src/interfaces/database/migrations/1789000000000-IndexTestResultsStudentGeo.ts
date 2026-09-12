import { MigrationInterface, QueryRunner } from 'typeorm';

// The teacher dashboard lists a school's students from their latest
// test_results_student row (compute-time school); membership is looked up by
// geo_entity_id first, then narrowed to each student's latest row.
export class IndexTestResultsStudentGeo1789000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_test_results_student_geo_entity" ON "test_results_student" ("geo_entity_id", "student_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_test_results_student_geo_entity"`);
  }
}
