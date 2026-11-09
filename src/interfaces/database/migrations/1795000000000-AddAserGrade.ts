import { MigrationInterface, QueryRunner } from 'typeorm';

// The ASER proxy as one dashboard metric, `aser_grade` (aser.ts aserTestLevel /
// aserGradePassed, test-results.service.ts): among 6–7 year olds with an
// ASER result, the share reading at their grade — six-year-olds who pass
// the paragraph or the story, seven-year-olds who pass the story. Same
// column shapes as the other test metrics, so the dashboard reads it like
// them: per student score (ASER level ÷ 4; NULL outside the age band) /
// passed / attempts; per area n / sum / sumsq / pass / hist[5] (levels 0–4).
//
// Additive only, no backfill: area rows fill in from the next nightly run
// (worked out from the aser_lN_* columns already stored); a student's own
// columns on their next rescore, or at once with POST
// admin/test-results/run?full=true.
export class AddAserGrade1795000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "test_results_student"
        ADD COLUMN "aser_grade_score" numeric(4,3),
        ADD COLUMN "aser_grade_passed" boolean,
        ADD COLUMN "aser_grade_attempts" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "test_results_geo_entity"
        ADD COLUMN "aser_grade_n" integer NOT NULL DEFAULT 0,
        ADD COLUMN "aser_grade_sum" numeric(10,3) NOT NULL DEFAULT 0,
        ADD COLUMN "aser_grade_sumsq" numeric(12,4) NOT NULL DEFAULT 0,
        ADD COLUMN "aser_grade_pass" integer NOT NULL DEFAULT 0,
        ADD COLUMN "aser_grade_hist" integer[] NOT NULL DEFAULT '{0,0,0,0,0}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "test_results_geo_entity"
        DROP COLUMN "aser_grade_hist", DROP COLUMN "aser_grade_pass", DROP COLUMN "aser_grade_sumsq",
        DROP COLUMN "aser_grade_sum", DROP COLUMN "aser_grade_n"`,
    );
    await queryRunner.query(
      `ALTER TABLE "test_results_student"
        DROP COLUMN "aser_grade_attempts", DROP COLUMN "aser_grade_passed", DROP COLUMN "aser_grade_score"`,
    );
  }
}
