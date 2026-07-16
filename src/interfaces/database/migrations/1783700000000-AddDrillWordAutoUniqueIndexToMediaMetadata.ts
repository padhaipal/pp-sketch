import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDrillWordAutoUniqueIndexToMediaMetadata1783700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Uniqueness ONLY for auto-created drill-word text rows: human-seeded
    // media keeps its many-rows-per-stid behavior (random selection pool),
    // while concurrent auto-creates for the same drilled word collapse to a
    // single row via ON CONFLICT DO NOTHING.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_media_metadata_drill_word_auto"
       ON "media_metadata" ("state_transition_id")
       WHERE source = 'drill-word-auto'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_media_metadata_drill_word_auto"`);
  }
}
