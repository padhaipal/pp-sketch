import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWaUploadedAtToMediaMetadata1783439975047 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Nullable, no default: metadata-only change, no table rewrite. NULL on
    // existing rows deliberately means "upload age unknown — overdue"; the
    // media-reload-sweep re-uploads those first and stamps them.
    await queryRunner.query(
      `ALTER TABLE "media_metadata" ADD COLUMN "wa_uploaded_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_metadata" DROP COLUMN "wa_uploaded_at"`,
    );
  }
}
