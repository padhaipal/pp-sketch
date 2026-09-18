import { MigrationInterface, QueryRunner } from 'typeorm';

// Usage metric (test-results.service.ts): active minutes per student on the
// IST day before computed_for, pass > 5 min; per area n/sum/sumsq/pass and a
// whole-minute histogram 0…30+. Additive only; no backfill — earlier rows
// keep NULL usage, which every reader treats as zero.
export class AddUsageMetric1790000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "test_results_student"
        ADD COLUMN "usage_score" numeric(6,1),
        ADD COLUMN "usage_passed" boolean,
        ADD COLUMN "usage_attempts" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "test_results_geo_entity"
        ADD COLUMN "usage_n" integer NOT NULL DEFAULT 0,
        ADD COLUMN "usage_sum" numeric(12,1) NOT NULL DEFAULT 0,
        ADD COLUMN "usage_sumsq" numeric(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN "usage_pass" integer NOT NULL DEFAULT 0,
        ADD COLUMN "usage_hist" integer[] NOT NULL DEFAULT '{${Array(31).fill(0).join(',')}}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "test_results_geo_entity"
        DROP COLUMN "usage_hist", DROP COLUMN "usage_pass", DROP COLUMN "usage_sumsq",
        DROP COLUMN "usage_sum", DROP COLUMN "usage_n"`,
    );
    await queryRunner.query(
      `ALTER TABLE "test_results_student"
        DROP COLUMN "usage_attempts", DROP COLUMN "usage_passed", DROP COLUMN "usage_score"`,
    );
  }
}
