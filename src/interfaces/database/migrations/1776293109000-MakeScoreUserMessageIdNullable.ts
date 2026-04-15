import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeScoreUserMessageIdNullable1776293109000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scores" ALTER COLUMN "user_message_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" DROP CONSTRAINT "FK_4d41ed03ef377aa836cc34f5f6d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" ADD CONSTRAINT "FK_4d41ed03ef377aa836cc34f5f6d" FOREIGN KEY ("user_message_id") REFERENCES "media_metadata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "scores" WHERE "user_message_id" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" ALTER COLUMN "user_message_id" SET NOT NULL`,
    );
  }
}
