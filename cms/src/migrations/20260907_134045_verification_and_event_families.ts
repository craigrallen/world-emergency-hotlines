import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" ADD COLUMN "_verified" boolean;
  ALTER TABLE "users" ADD COLUMN "_verificationtoken" varchar;
  ALTER TABLE "subscriptions" ADD COLUMN "last_checkout_event_created" numeric;
  ALTER TABLE "subscriptions" ADD COLUMN "last_subscription_event_created" numeric;
  ALTER TABLE "subscriptions" ADD COLUMN "last_invoice_event_created" numeric;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" DROP COLUMN "_verified";
  ALTER TABLE "users" DROP COLUMN "_verificationtoken";
  ALTER TABLE "subscriptions" DROP COLUMN "last_checkout_event_created";
  ALTER TABLE "subscriptions" DROP COLUMN "last_subscription_event_created";
  ALTER TABLE "subscriptions" DROP COLUMN "last_invoice_event_created";`)
}
