import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMailingListEntries1777080188504 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "mailing_list_entries" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "email" text NOT NULL,
         "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_mailing_list_entries" PRIMARY KEY ("id"),
         CONSTRAINT "uq_mailing_list_entries_email" UNIQUE ("email")
       )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mailing_list_entries"`);
  }
}
