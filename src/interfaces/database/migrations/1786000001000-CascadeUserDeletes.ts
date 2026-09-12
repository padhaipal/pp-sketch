import { MigrationInterface, QueryRunner } from 'typeorm';

// Every FK that hangs off a user (directly, or via the user's own media
// rows) becomes ON DELETE CASCADE so `DELETE FROM users` is the whole
// per-user delete (UserService.delete). Content-side FKs stay NO ACTION:
// users.referrer_user_id (nulled explicitly first), outbound_messages.
// media_metadata_id, literacy_lesson_states.passage_id, letters.
// media_metadata_id — a content purge must never silently erase lesson
// history or letters. foreign-keys.spec.ts enforces the split.
//
// Runs OUTSIDE a transaction (`transaction = false`; migration:run uses
// `-t each`) so ADD CONSTRAINT … NOT VALID takes only a brief lock and
// VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE. Consequence: no
// atomic revert — every step is idempotent (DROP IF EXISTS before ADD) so
// a partially applied run can simply be re-run, and down() tolerates any
// intermediate state the same way. Constraint names are kept so the
// original CreateTables definitions are superseded by name.
export class CascadeUserDeletes1786000001000 implements MigrationInterface {
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" DROP CONSTRAINT IF EXISTS "FK_425c5db73fc150e3ef0a0537aa7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" ADD CONSTRAINT "FK_425c5db73fc150e3ef0a0537aa7" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" VALIDATE CONSTRAINT "FK_425c5db73fc150e3ef0a0537aa7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" DROP CONSTRAINT IF EXISTS "FK_c76f64dd1ebbfa4bc07a398771a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" ADD CONSTRAINT "FK_c76f64dd1ebbfa4bc07a398771a" FOREIGN KEY ("user_message_id") REFERENCES "media_metadata"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" VALIDATE CONSTRAINT "FK_c76f64dd1ebbfa4bc07a398771a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" DROP CONSTRAINT IF EXISTS "FK_683c8208c44184cae37649140c0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" ADD CONSTRAINT "FK_683c8208c44184cae37649140c0" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" VALIDATE CONSTRAINT "FK_683c8208c44184cae37649140c0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" DROP CONSTRAINT IF EXISTS "FK_4d41ed03ef377aa836cc34f5f6d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" ADD CONSTRAINT "FK_4d41ed03ef377aa836cc34f5f6d" FOREIGN KEY ("user_message_id") REFERENCES "media_metadata"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" VALIDATE CONSTRAINT "FK_4d41ed03ef377aa836cc34f5f6d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" DROP CONSTRAINT IF EXISTS "FK_1e873e1c300559f047b1caf3d52"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" ADD CONSTRAINT "FK_1e873e1c300559f047b1caf3d52" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" VALIDATE CONSTRAINT "FK_1e873e1c300559f047b1caf3d52"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" DROP CONSTRAINT IF EXISTS "FK_d348669bee115476b8881a615fe"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" ADD CONSTRAINT "FK_d348669bee115476b8881a615fe" FOREIGN KEY ("input_media_id") REFERENCES "media_metadata"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" VALIDATE CONSTRAINT "FK_d348669bee115476b8881a615fe"`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" DROP CONSTRAINT IF EXISTS "FK_outbound_messages_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" ADD CONSTRAINT "FK_outbound_messages_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" VALIDATE CONSTRAINT "FK_outbound_messages_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" DROP CONSTRAINT IF EXISTS "FK_outbound_messages_user_message"`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" ADD CONSTRAINT "FK_outbound_messages_user_message" FOREIGN KEY ("user_message_id") REFERENCES "media_metadata"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" VALIDATE CONSTRAINT "FK_outbound_messages_user_message"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" DROP CONSTRAINT IF EXISTS "FK_425c5db73fc150e3ef0a0537aa7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" ADD CONSTRAINT "FK_425c5db73fc150e3ef0a0537aa7" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" VALIDATE CONSTRAINT "FK_425c5db73fc150e3ef0a0537aa7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" DROP CONSTRAINT IF EXISTS "FK_c76f64dd1ebbfa4bc07a398771a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" ADD CONSTRAINT "FK_c76f64dd1ebbfa4bc07a398771a" FOREIGN KEY ("user_message_id") REFERENCES "media_metadata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "literacy_lesson_states" VALIDATE CONSTRAINT "FK_c76f64dd1ebbfa4bc07a398771a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" DROP CONSTRAINT IF EXISTS "FK_683c8208c44184cae37649140c0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" ADD CONSTRAINT "FK_683c8208c44184cae37649140c0" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" VALIDATE CONSTRAINT "FK_683c8208c44184cae37649140c0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" DROP CONSTRAINT IF EXISTS "FK_4d41ed03ef377aa836cc34f5f6d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" ADD CONSTRAINT "FK_4d41ed03ef377aa836cc34f5f6d" FOREIGN KEY ("user_message_id") REFERENCES "media_metadata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "scores" VALIDATE CONSTRAINT "FK_4d41ed03ef377aa836cc34f5f6d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" DROP CONSTRAINT IF EXISTS "FK_1e873e1c300559f047b1caf3d52"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" ADD CONSTRAINT "FK_1e873e1c300559f047b1caf3d52" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" VALIDATE CONSTRAINT "FK_1e873e1c300559f047b1caf3d52"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" DROP CONSTRAINT IF EXISTS "FK_d348669bee115476b8881a615fe"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" ADD CONSTRAINT "FK_d348669bee115476b8881a615fe" FOREIGN KEY ("input_media_id") REFERENCES "media_metadata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_metadata" VALIDATE CONSTRAINT "FK_d348669bee115476b8881a615fe"`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" DROP CONSTRAINT IF EXISTS "FK_outbound_messages_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" ADD CONSTRAINT "FK_outbound_messages_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" VALIDATE CONSTRAINT "FK_outbound_messages_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" DROP CONSTRAINT IF EXISTS "FK_outbound_messages_user_message"`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" ADD CONSTRAINT "FK_outbound_messages_user_message" FOREIGN KEY ("user_message_id") REFERENCES "media_metadata"("id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "outbound_messages" VALIDATE CONSTRAINT "FK_outbound_messages_user_message"`,
    );
  }
}
