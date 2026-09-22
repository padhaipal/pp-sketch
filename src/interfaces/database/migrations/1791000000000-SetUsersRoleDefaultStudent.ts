import { MigrationInterface, QueryRunner } from 'typeorm';

// AddStaffFieldsToUsers backfilled role NULL → 'student' once, but
// UserService.create() kept inserting NULL, so every account created since
// that deploy (2026-09-17) was roleless and invisible to the nightly
// test-results run, the dashboards and the onboarding lookup. create() now
// writes 'student' on every branch; this migration re-runs the backfill and
// adds a column default as a second guard. Additive; down() only drops the
// default (the UPDATE is the same one AddStaffFieldsToUsers.down reverses).
export class SetUsersRoleDefaultStudent1791000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'student'`,
    );
    await queryRunner.query(
      `UPDATE "users" SET "role" = 'student' WHERE "role" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT`,
    );
  }
}
