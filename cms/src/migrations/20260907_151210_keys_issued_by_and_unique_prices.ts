import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_api_keys_issued_by" AS ENUM('account', 'admin');
  ALTER TABLE "api_keys" ADD COLUMN "issued_by" "enum_api_keys_issued_by" DEFAULT 'admin' NOT NULL;
  CREATE UNIQUE INDEX "plans_stripe_price_id_idx" ON "plans" USING btree ("stripe_price_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "plans_stripe_price_id_idx";
  ALTER TABLE "api_keys" DROP COLUMN "issued_by";
  DROP TYPE "public"."enum_api_keys_issued_by";`)
}
