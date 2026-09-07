import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "stripe_events" ADD COLUMN "lease" varchar;
  CREATE INDEX "stripe_events_lease_idx" ON "stripe_events" USING btree ("lease");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "stripe_events_lease_idx";
  ALTER TABLE "stripe_events" DROP COLUMN "lease";`)
}
