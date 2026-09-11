import { MigrationInterface, QueryRunner } from 'typeorm';

// Administrative geography for the education-official product: one table,
// one row per country / state / district / block / school, parent-linked.
// 'cluster' is in the type enum but no cluster rows are seeded (the register's
// clusterCd field is too dirty to key on — see src/scripts/seed-geo-entities.prompt.md);
// having the value lets the level be added later without a migration.
export class CreateGeoEntity1787000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "geo_entity_type" AS ENUM ('country', 'state', 'district', 'block', 'cluster', 'school')`,
    );
    await queryRunner.query(
      `CREATE TYPE "geo_entity_status" AS ENUM ('operational', 'closed', 'permanently_closed', 'merged', 'sanctioned_not_operational', 'dcf_not_received')`,
    );
    await queryRunner.query(
      `CREATE TYPE "management_group" AS ENUM ('government', 'government_aided', 'private', 'other')`,
    );
    await queryRunner.query(
      `CREATE TABLE "geo_entity" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "type" "geo_entity_type" NOT NULL,
        "parent_id" uuid,
        "code" text NOT NULL,
        "name" text NOT NULL,
        "lgd_code" text,
        "lat" double precision,
        "lng" double precision,
        "has_boundary" boolean NOT NULL DEFAULT false,
        "status" "geo_entity_status" NOT NULL DEFAULT 'operational',
        "merged_into_id" uuid,
        "management_group" "management_group",
        "class_from" smallint,
        "class_to" smallint,
        "attributes" jsonb NOT NULL DEFAULT '{}',
        "source" text NOT NULL,
        "source_pulled_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_geo_entity" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_geo_entity_type_code" UNIQUE ("type", "code"),
        CONSTRAINT "FK_geo_entity_parent" FOREIGN KEY ("parent_id") REFERENCES "geo_entity"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_geo_entity_merged_into" FOREIGN KEY ("merged_into_id") REFERENCES "geo_entity"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_geo_entity_parent_id" ON "geo_entity" ("parent_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_geo_entity_type_status" ON "geo_entity" ("type", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_geo_entity_merged_into_id" ON "geo_entity" ("merged_into_id")`,
    );
    // A future CRC view resolves its schools by clusterCd, not by tree walk.
    await queryRunner.query(
      `CREATE INDEX "idx_geo_entity_school_cluster_cd" ON "geo_entity" ((attributes->>'clusterCd')) WHERE type = 'school'`,
    );
    // The seed's merged-pointer update joins schIdMerged → schoolId.
    await queryRunner.query(
      `CREATE INDEX "idx_geo_entity_school_school_id" ON "geo_entity" ((attributes->>'schoolId')) WHERE type = 'school'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "geo_entity"`);
    await queryRunner.query(`DROP TYPE "management_group"`);
    await queryRunner.query(`DROP TYPE "geo_entity_status"`);
    await queryRunner.query(`DROP TYPE "geo_entity_type"`);
  }
}
