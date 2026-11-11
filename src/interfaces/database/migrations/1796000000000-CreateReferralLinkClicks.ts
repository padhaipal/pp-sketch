import { MigrationInterface, QueryRunner } from 'typeorm';

// One row per tap on a teacher's /r/<phone> referral link (recorded by the
// dashboard's redirect before it sends the visitor on to WhatsApp).
//
// - referrer_user_id: the teacher, resolved from the link's phone number at
//   insert time. CASCADE so deleting a user removes their clicks too.
// - unmatched_referrer: the raw link segment, kept ONLY when no user has
//   that external_id (a mistyped or not-yet-registered number), so a known
//   teacher's phone number is never copied into this table.
// - visitor_hash: HMAC of (IST day, IP, user agent) computed by the
//   dashboard. Counts distinct visitors per day; no IP is stored.
export class CreateReferralLinkClicks1796000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "referral_link_clicks" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "referrer_user_id" uuid,
         "unmatched_referrer" text,
         "visitor_hash" text NOT NULL,
         "clicked_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_referral_link_clicks" PRIMARY KEY ("id"),
         CONSTRAINT "FK_referral_link_clicks_referrer_user_id" FOREIGN KEY ("referrer_user_id") REFERENCES "users"("id") ON DELETE CASCADE
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_referral_link_clicks_referrer_clicked_at"
         ON "referral_link_clicks" ("referrer_user_id", "clicked_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "referral_link_clicks"`);
  }
}
