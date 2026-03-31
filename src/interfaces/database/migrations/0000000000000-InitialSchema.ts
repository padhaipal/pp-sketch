import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema0000000000000 implements MigrationInterface {
  name = 'InitialSchema0000000000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    // Baseline: tables already exist in production.
    // This migration exists so TypeORM's migration history starts clean.
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // No-op: not dropping production tables.
  }
}
