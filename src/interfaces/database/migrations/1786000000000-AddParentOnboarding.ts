import { MigrationInterface, QueryRunner } from 'typeorm';

// Parent onboarding (2026-09): three nullable columns on users, filled when
// the onboarding machine reaches `done`, and the append-only
// onboarding_states table (one row per turn; newest row = current state).
// Backwards compatible: nothing existing changes shape.
export class AddParentOnboarding1786000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "birth_year" smallint`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "birth_month" smallint`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "recording_permissions_obtained_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE TABLE "onboarding_states" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "user_message_id" uuid NOT NULL,
        "snapshot" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_onboarding_states" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_onboarding_states_user_message_id" UNIQUE ("user_message_id"),
        CONSTRAINT "FK_onboarding_states_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_onboarding_states_user_message" FOREIGN KEY ("user_message_id") REFERENCES "media_metadata"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_onboarding_states_user_id_created" ON "onboarding_states" ("user_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "onboarding_states"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "recording_permissions_obtained_at"`,
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "birth_month"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "birth_year"`);
  }
}
