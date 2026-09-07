import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'
import { getEnv } from '../env'

// Stripe keeps test-mode and live-mode objects in separate namespaces, so an account now
// holds one customer id per billing mode (lib/customers.ts). Customer ids that already
// exist were created in the mode this deployment runs in at migration time (the documented
// flow runs test first, then live), so they move to that mode's column: a later promotion
// to live then creates live customers instead of reusing test ids the live client refuses.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" RENAME COLUMN "stripe_customer_id" TO "stripe_live_customer_id";
  ALTER INDEX "users_stripe_customer_id_idx" RENAME TO "users_stripe_live_customer_id_idx";
  ALTER TABLE "users" ADD COLUMN "stripe_test_customer_id" varchar;
  CREATE UNIQUE INDEX "users_stripe_test_customer_id_idx" ON "users" USING btree ("stripe_test_customer_id");`)
  if (getEnv().stripeMode !== 'live') {
    await db.execute(sql`UPDATE "users" SET "stripe_test_customer_id" = "stripe_live_customer_id", "stripe_live_customer_id" = NULL WHERE "stripe_live_customer_id" IS NOT NULL;`)
  }
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   UPDATE "users" SET "stripe_live_customer_id" = COALESCE("stripe_live_customer_id", "stripe_test_customer_id");
  DROP INDEX "users_stripe_test_customer_id_idx";
  ALTER TABLE "users" DROP COLUMN "stripe_test_customer_id";
  ALTER INDEX "users_stripe_live_customer_id_idx" RENAME TO "users_stripe_customer_id_idx";
  ALTER TABLE "users" RENAME COLUMN "stripe_live_customer_id" TO "stripe_customer_id";`)
}
