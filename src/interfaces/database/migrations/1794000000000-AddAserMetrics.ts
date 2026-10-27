import { MigrationInterface, QueryRunner } from 'typeorm';

// ASER (Hindi) proxy (literacy/aser/aser.ts, test-results.service.ts): four
// tests — l1 letter, l2 word, l3 paragraph, l4 story. Per student, the
// latest finished run that reached each test: right / wrong counts (kept
// even when the test was left undecided), the verdict (NULL = undecided)
// and when that run ended. Per area, for each test: students who took it
// (n) and how many passed / failed. No age band — every student counts.
//
// Additive only, no backfill: rows written before this deploy keep NULLs
// and zero counts; a student's ASER appears on their next rescore.
const TESTS = ['l1', 'l2', 'l3', 'l4'];

export class AddAserMetrics1794000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "test_results_student"
        ${TESTS.map(
          (t) => `ADD COLUMN "aser_${t}_correct" integer,
        ADD COLUMN "aser_${t}_incorrect" integer,
        ADD COLUMN "aser_${t}_passed" boolean,
        ADD COLUMN "aser_${t}_at" timestamptz`,
        ).join(',\n        ')}`,
    );
    await queryRunner.query(
      `ALTER TABLE "test_results_geo_entity"
        ${TESTS.map(
          (t) => `ADD COLUMN "aser_${t}_n" integer NOT NULL DEFAULT 0,
        ADD COLUMN "aser_${t}_pass" integer NOT NULL DEFAULT 0,
        ADD COLUMN "aser_${t}_fail" integer NOT NULL DEFAULT 0`,
        ).join(',\n        ')}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "test_results_geo_entity"
        ${TESTS.map(
          (t) =>
            `DROP COLUMN "aser_${t}_fail", DROP COLUMN "aser_${t}_pass", DROP COLUMN "aser_${t}_n"`,
        ).join(', ')}`,
    );
    await queryRunner.query(
      `ALTER TABLE "test_results_student"
        ${TESTS.map(
          (t) =>
            `DROP COLUMN "aser_${t}_at", DROP COLUMN "aser_${t}_passed", DROP COLUMN "aser_${t}_incorrect", DROP COLUMN "aser_${t}_correct"`,
        ).join(', ')}`,
    );
  }
}
