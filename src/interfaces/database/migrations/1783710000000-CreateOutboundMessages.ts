import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOutboundMessages1783710000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // "trigger" is a reserved word in Postgres — quoted everywhere.
    await queryRunner.query(
      `CREATE TABLE "outbound_messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "user_message_id" uuid,
        "trigger" text NOT NULL DEFAULT 'other',
        "state_transition_id" text,
        "media_metadata_id" uuid NOT NULL,
        "status" text NOT NULL DEFAULT 'sent',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_outbound_messages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_outbound_messages_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_outbound_messages_user_message" FOREIGN KEY ("user_message_id") REFERENCES "media_metadata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_outbound_messages_media" FOREIGN KEY ("media_metadata_id") REFERENCES "media_metadata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_outbound_messages_user_id_created" ON "outbound_messages" ("user_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_outbound_messages_user_message_id" ON "outbound_messages" ("user_message_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "outbound_messages"`);
  }
}
