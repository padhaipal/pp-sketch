import { MigrationInterface, QueryRunner } from 'typeorm';

export class PromoteWebpImageToSticker1776340800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE media_metadata SET media_type = 'sticker' WHERE media_type = 'image' AND media_details->>'mime_type' = 'image/webp'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE media_metadata SET media_type = 'image' WHERE media_type = 'sticker'`,
    );
  }
}
