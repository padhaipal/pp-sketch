import { MigrationInterface, QueryRunner } from 'typeorm';

// Staff accounts (education officials) on the users table. The role CHECK
// from AddUserAuthFields (role IN ('admin','dev')) is dropped and NOT
// re-added: role stays text with enforcement in code (USER_ROLES in
// user.dto.ts), matching the existing convention. NOT cleanly reversible once
// staff accounts exist — down() nulls every non-admin/dev role (students
// included, which merely returns them to the pre-migration NULL) before
// restoring the two-value CHECK, and drops the staff columns with their data.
export class AddStaffFieldsToUsers1787000001000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Postgres names an unnamed inline column CHECK <table>_<column>_check.
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_role_check"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users"
        ADD COLUMN "geo_entity_id" uuid,
        ADD COLUMN "role_title" text,
        ADD COLUMN "avatar_seed" text,
        ADD COLUMN "spotlight_message" text,
        ADD COLUMN "staff_notes" text,
        ADD COLUMN "deleted_at" TIMESTAMP WITH TIME ZONE`,
    );
    // Deleting a school must not delete its teacher: SET NULL, never CASCADE.
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "FK_users_geo_entity" FOREIGN KEY ("geo_entity_id") REFERENCES "geo_entity"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_geo_entity_id" ON "users" ("geo_entity_id")`,
    );
    await queryRunner.query(
      `UPDATE "users" SET "role" = 'student' WHERE "role" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "users" SET "role" = NULL WHERE "role" NOT IN ('admin', 'dev')`,
    );
    await queryRunner.query(`DROP INDEX "idx_users_geo_entity_id"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "FK_users_geo_entity"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users"
        DROP COLUMN "deleted_at",
        DROP COLUMN "staff_notes",
        DROP COLUMN "spotlight_message",
        DROP COLUMN "avatar_seed",
        DROP COLUMN "role_title",
        DROP COLUMN "geo_entity_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK (role IN ('admin', 'dev'))`,
    );
  }
}
