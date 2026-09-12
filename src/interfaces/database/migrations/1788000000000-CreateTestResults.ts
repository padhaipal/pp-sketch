import { MigrationInterface, QueryRunner } from 'typeorm';

// Nightly literacy-test results (src/literacy/score/test-results.service.ts).
//
// test_results_student — one row per student per computed_for: the three
// snapshot-test scores (NIPUN g2 / g3 / MPL-B) plus the school the student's
// referrer belonged to at compute time.
//
// test_results_geo_entity — one row per geo entity per computed_for holding
// SUMS, SUMS OF SQUARES and exact HISTOGRAMS per metric rather than
// averages: they roll up additively (a block's vector is the element-wise
// sum of its schools'), and the histogram yields exact mean, sd, median, any
// percentile and any pass threshold without reading student rows. The
// histograms are exact, not bucketed: nipunSnapshot always divides by 4 and
// mplBSnapshot by 20, so the score space is discrete (5 and 21 values).
//
// test_runs — one row per job run for observability and the overlap guard.
const NIPUN_ZEROS = "'{0,0,0,0,0}'";
const MPL_B_ZEROS = `'{${Array(21).fill(0).join(',')}}'`;

function metricColumns(metric: string, histZeros: string): string {
  return `
        "${metric}_n" integer NOT NULL DEFAULT 0,
        "${metric}_sum" numeric(10,3) NOT NULL DEFAULT 0,
        "${metric}_sumsq" numeric(12,4) NOT NULL DEFAULT 0,
        "${metric}_pass" integer NOT NULL DEFAULT 0,
        "${metric}_hist" integer[] NOT NULL DEFAULT ${histZeros},`;
}

export class CreateTestResults1788000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "test_results_student" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "student_id" uuid NOT NULL,
        "geo_entity_id" uuid,
        "computed_for" date NOT NULL,
        "nipun_g2_score" numeric(4,3),
        "nipun_g2_passed" boolean,
        "nipun_g2_attempts" integer NOT NULL DEFAULT 0,
        "nipun_g3_score" numeric(4,3),
        "nipun_g3_passed" boolean,
        "nipun_g3_attempts" integer NOT NULL DEFAULT 0,
        "mpl_b_score" numeric(4,3),
        "mpl_b_passed" boolean,
        "mpl_b_attempts" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_test_results_student" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_test_results_student_computed_for" UNIQUE ("student_id", "computed_for"),
        CONSTRAINT "FK_test_results_student_student" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_test_results_student_geo_entity" FOREIGN KEY ("geo_entity_id") REFERENCES "geo_entity"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_test_results_student_student_created" ON "test_results_student" ("student_id", "created_at" DESC)`,
    );

    await queryRunner.query(
      `CREATE TABLE "test_results_geo_entity" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "geo_entity_id" uuid NOT NULL,
        "computed_for" date NOT NULL,
        "students_active" integer NOT NULL,
        "students_scored" integer NOT NULL,
        "students_unbanded" integer NOT NULL,${metricColumns('nipun_g2', NIPUN_ZEROS)}${metricColumns('nipun_g3', NIPUN_ZEROS)}${metricColumns('mpl_b', MPL_B_ZEROS)}
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_test_results_geo_entity" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_test_results_geo_entity_computed_for" UNIQUE ("geo_entity_id", "computed_for"),
        CONSTRAINT "FK_test_results_geo_entity_geo_entity" FOREIGN KEY ("geo_entity_id") REFERENCES "geo_entity"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_test_results_geo_entity_geo_computed" ON "test_results_geo_entity" ("geo_entity_id", "computed_for" DESC)`,
    );

    await queryRunner.query(
      `CREATE TABLE "test_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "finished_at" TIMESTAMP WITH TIME ZONE,
        "full" boolean NOT NULL DEFAULT false,
        "students_candidates" integer NOT NULL DEFAULT 0,
        "students_scored" integer NOT NULL DEFAULT 0,
        "geo_rows" integer NOT NULL DEFAULT 0,
        "status" text NOT NULL,
        "error" text,
        CONSTRAINT "PK_test_runs" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_test_runs_status" CHECK ("status" IN ('running', 'ok', 'failed'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_test_runs_status_started" ON "test_runs" ("status", "started_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "test_runs"`);
    await queryRunner.query(`DROP TABLE "test_results_geo_entity"`);
    await queryRunner.query(`DROP TABLE "test_results_student"`);
  }
}
