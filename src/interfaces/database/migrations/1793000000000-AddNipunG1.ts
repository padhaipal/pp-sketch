import { MigrationInterface, QueryRunner } from 'typeorm';

// NIPUN grade 1 (literacy-test-scores.ts, test-results.service.ts): the
// year below grade 2 (age band [6, 7)), scored over the child's last four
// finished level-8 lessons — each a pass when the passage was read right on
// the first try (score = passes / 4, pass ≥ 0.75). Same column shapes as
// nipun_g2/nipun_g3: per student score/passed/attempts, per area
// n/sum/sumsq/pass/hist[5] plus the band's cohort for the school verdict,
// which now needs all three bands.
//
// Additive only, no backfill: rows written before this deploy keep NULL
// scores and zero vectors — "moving forward" by decision (2026-10).
export class AddNipunG11793000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "test_results_student"
        ADD COLUMN "nipun_g1_score" numeric(4,3),
        ADD COLUMN "nipun_g1_passed" boolean,
        ADD COLUMN "nipun_g1_attempts" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "test_results_geo_entity"
        ADD COLUMN "nipun_g1_cohort" integer NOT NULL DEFAULT 0,
        ADD COLUMN "nipun_g1_n" integer NOT NULL DEFAULT 0,
        ADD COLUMN "nipun_g1_sum" numeric(10,3) NOT NULL DEFAULT 0,
        ADD COLUMN "nipun_g1_sumsq" numeric(12,4) NOT NULL DEFAULT 0,
        ADD COLUMN "nipun_g1_pass" integer NOT NULL DEFAULT 0,
        ADD COLUMN "nipun_g1_hist" integer[] NOT NULL DEFAULT '{0,0,0,0,0}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "test_results_geo_entity"
        DROP COLUMN "nipun_g1_hist", DROP COLUMN "nipun_g1_pass", DROP COLUMN "nipun_g1_sumsq",
        DROP COLUMN "nipun_g1_sum", DROP COLUMN "nipun_g1_n", DROP COLUMN "nipun_g1_cohort"`,
    );
    await queryRunner.query(
      `ALTER TABLE "test_results_student"
        DROP COLUMN "nipun_g1_attempts", DROP COLUMN "nipun_g1_passed", DROP COLUMN "nipun_g1_score"`,
    );
  }
}
