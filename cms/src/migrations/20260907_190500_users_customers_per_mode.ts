import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// Stripe keeps test-mode and live-mode objects in separate namespaces, so an account now
// holds one customer id per billing mode (lib/customers.ts). A legacy customer id (from
// before this migration) is not moved based on the deployment's *current* STRIPE_SECRET_KEY:
// an operator who switches the key to live and then runs migrations in the same deploy would
// have every legacy id misfiled as live, so checkout and the portal would reuse a test-only id
// with the live client and fail. Instead an explicit, migration-only override says what mode
// the legacy ids were actually created in: CMS_LEGACY_STRIPE_CUSTOMER_MODE ('test' or 'live'),
// defaulting to 'test' to match the documented rollout (test first, then a later promotion to
// live creates live customers fresh). A deployment that was already live before this migration
// must set the override to 'live' explicitly.
function legacyIsLive(): boolean {
  const value = process.env.CMS_LEGACY_STRIPE_CUSTOMER_MODE
  if (value === undefined || value === '') return false
  if (value === 'live') return true
  if (value === 'test') return false
  throw new Error('CMS_LEGACY_STRIPE_CUSTOMER_MODE must be "test" or "live"')
}

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" RENAME COLUMN "stripe_customer_id" TO "stripe_live_customer_id";
  ALTER INDEX "users_stripe_customer_id_idx" RENAME TO "users_stripe_live_customer_id_idx";
  ALTER TABLE "users" ADD COLUMN "stripe_test_customer_id" varchar;
  CREATE UNIQUE INDEX "users_stripe_test_customer_id_idx" ON "users" USING btree ("stripe_test_customer_id");`)
  if (!legacyIsLive()) {
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
