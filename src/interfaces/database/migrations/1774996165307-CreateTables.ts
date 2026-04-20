import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTables1774996165307 implements MigrationInterface {
  name = 'CreateTables1774996165307';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "external_id" text NOT NULL, "referrer_user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_11fc776e0ca3573dc195670f636" UNIQUE ("external_id"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_external_id" ON "users" ("external_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "media_metadata" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "media_type" text NOT NULL, "source" text NOT NULL, "status" text NOT NULL DEFAULT 'created', "wa_media_url" text, "s3_key" text, "content_hash" text, "state_transition_id" text, "text" text, "media_details" jsonb, "generation_request_json" jsonb, "input_media_id" uuid, "user_id" uuid, "rolled_back" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6c52273ad7331542bbce7ae4da1" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_media_metadata_wa_media_url" ON "media_metadata" ("wa_media_url") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_media_metadata_state_transition_id" ON "media_metadata" ("state_transition_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_media_metadata_input_media_id" ON "media_metadata" ("input_media_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_media_metadata_user_id" ON "media_metadata" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_media_metadata_content_hash_stid" ON "media_metadata" ("content_hash", "state_transition_id") WHERE "content_hash" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "letters" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "grapheme" text NOT NULL, "media_metadata_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_3b70d1dda84f3538f6d4adef09b" UNIQUE ("grapheme"), CONSTRAINT "PK_bf70c41d26aa84cf2651d571889" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_letters_grapheme" ON "letters" ("grapheme") `,
    );
    await queryRunner.query(
      `CREATE TABLE "scores" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "letter_id" uuid NOT NULL, "user_message_id" uuid NOT NULL, "score" double precision NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_c36917e6f26293b91d04b8fd521" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_scores_user_id" ON "scores" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_scores_letter_id" ON "scores" ("letter_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_scores_user_message_id" ON "scores" ("user_message_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "literacy_lesson_states" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "user_message_id" uuid NOT NULL, "word" text NOT NULL, "snapshot" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_baacc7dd5b178afc93f07d9b634" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_literacy_lesson_states_user_id_created" ON "literacy_lesson_states" ("user_id", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "FK_8c783e559c2b434f85ad34b9900" FOREIGN KEY ("referrer_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" ADD CONSTRAINT "FK_d348669bee115476b8881a615fe" FOREIGN KEY ("input_media_id") REFERENCES "media_metadata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" ADD CONSTRAINT "FK_1e873e1c300559f047b1caf3d52" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "letters" ADD CONSTRAINT "FK_0746aeec025e3cc069f0b9d0c10" FOREIGN KEY ("media_metadata_id") REFERENCES "media_metadata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" ADD CONSTRAINT "FK_683c8208c44184cae37649140c0" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" ADD CONSTRAINT "FK_822da02145f02f447d6d33e067e" FOREIGN KEY ("letter_id") REFERENCES "letters"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" ADD CONSTRAINT "FK_4d41ed03ef377aa836cc34f5f6d" FOREIGN KEY ("user_message_id") REFERENCES "media_metadata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" ADD CONSTRAINT "FK_425c5db73fc150e3ef0a0537aa7" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" ADD CONSTRAINT "FK_c76f64dd1ebbfa4bc07a398771a" FOREIGN KEY ("user_message_id") REFERENCES "media_metadata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" DROP CONSTRAINT "FK_c76f64dd1ebbfa4bc07a398771a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" DROP CONSTRAINT "FK_425c5db73fc150e3ef0a0537aa7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" DROP CONSTRAINT "FK_4d41ed03ef377aa836cc34f5f6d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" DROP CONSTRAINT "FK_822da02145f02f447d6d33e067e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" DROP CONSTRAINT "FK_683c8208c44184cae37649140c0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "letters" DROP CONSTRAINT "FK_0746aeec025e3cc069f0b9d0c10"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" DROP CONSTRAINT "FK_1e873e1c300559f047b1caf3d52"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" DROP CONSTRAINT "FK_d348669bee115476b8881a615fe"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "FK_8c783e559c2b434f85ad34b9900"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_literacy_lesson_states_user_id_created"`,
    );
    await queryRunner.query(`DROP TABLE "literacy_lesson_states"`);
    await queryRunner.query(`DROP INDEX "public"."idx_scores_user_message_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_scores_letter_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_scores_user_id"`);
    await queryRunner.query(`DROP TABLE "scores"`);
    await queryRunner.query(`DROP INDEX "public"."idx_letters_grapheme"`);
    await queryRunner.query(`DROP TABLE "letters"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_media_metadata_content_hash_stid"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_media_metadata_user_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_media_metadata_input_media_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_media_metadata_state_transition_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_media_metadata_wa_media_url"`,
    );
    await queryRunner.query(`DROP TABLE "media_metadata"`);
    await queryRunner.query(`DROP INDEX "public"."idx_users_external_id"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
