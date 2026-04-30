import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNameToMailingListEntries1777081010662 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mailing_list_entries" ADD COLUMN "name" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mailing_list_entries" DROP COLUMN "name"`,
    );
  }
}
