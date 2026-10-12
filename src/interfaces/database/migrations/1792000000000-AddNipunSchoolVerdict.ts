import { MigrationInterface, QueryRunner } from 'typeorm';

// School-level NIPUN verdict (test-results.service.ts, schoolVerdict):
//
// nipun_g2_cohort / nipun_g3_cohort — EVERY student of the school inside that
// band's age range on computed_for, scored or not (nipun_g*_n counts only the
// scored ones). Additive: an ancestor's cohort is the sum of its schools'.
//
// nipun_school_passed — school rows only: true / false / NULL (not enough
// students to decide). NULL on every non-school row.
//
// nipun_schools_pass / _fail / _insufficient — how many schools under this
// entity pass / fail / can't be decided. A school row is one-hot (its own
// verdict), so ancestors are the element-wise sum of their schools.
//
// Additive only, no backfill: rows written before this deploy keep the
// defaults (cohort 0, verdict NULL, counts 0) — "moving forward" by decision.
export class AddNipunSchoolVerdict1792000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "test_results_geo_entity"
        ADD COLUMN "nipun_g2_cohort" integer NOT NULL DEFAULT 0,
        ADD COLUMN "nipun_g3_cohort" integer NOT NULL DEFAULT 0,
        ADD COLUMN "nipun_school_passed" boolean,
        ADD COLUMN "nipun_schools_pass" integer NOT NULL DEFAULT 0,
        ADD COLUMN "nipun_schools_fail" integer NOT NULL DEFAULT 0,
        ADD COLUMN "nipun_schools_insufficient" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "test_results_geo_entity"
        DROP COLUMN "nipun_schools_insufficient",
        DROP COLUMN "nipun_schools_fail",
        DROP COLUMN "nipun_schools_pass",
        DROP COLUMN "nipun_school_passed",
        DROP COLUMN "nipun_g3_cohort",
        DROP COLUMN "nipun_g2_cohort"`,
    );
  }
}
