import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "api_keys" ADD COLUMN "subscription_id" integer;
  ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "api_keys_subscription_idx" ON "api_keys" USING btree ("subscription_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_subscription_id_subscriptions_id_fk";
  
  DROP INDEX "api_keys_subscription_idx";
  ALTER TABLE "api_keys" DROP COLUMN "subscription_id";`)
}
