import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserAuthFields1744540800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN password_hash TEXT,
        ADD COLUMN role TEXT CHECK (role IN ('admin', 'dev'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN role,
        DROP COLUMN password_hash
    `);
  }
}
