import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  // Claims become unique per consumer and event (claim_key = source:event_id) instead
  // of per event, so the CMS webhook and the payments service each process every
  // event. Existing rows are backfilled before the column becomes NOT NULL.
  await db.execute(sql`
   DROP INDEX "stripe_events_event_id_idx";
  ALTER TABLE "stripe_events" ADD COLUMN "claim_key" varchar;
  UPDATE "stripe_events" SET "claim_key" = "source" || ':' || "event_id" WHERE "claim_key" IS NULL;
  ALTER TABLE "stripe_events" ALTER COLUMN "claim_key" SET NOT NULL;
  CREATE UNIQUE INDEX "stripe_events_claim_key_idx" ON "stripe_events" USING btree ("claim_key");
  CREATE INDEX "stripe_events_event_id_idx" ON "stripe_events" USING btree ("event_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Reverting to one claim per event keeps the payments service's claims (its work
  // is the durable store) and drops the CMS webhook's duplicates of the same event.
  await db.execute(sql`
   DROP INDEX "stripe_events_claim_key_idx";
  DROP INDEX "stripe_events_event_id_idx";
  DELETE FROM "stripe_events" a USING "stripe_events" b WHERE a."event_id" = b."event_id" AND a."source" = 'cms' AND b."source" = 'payments';
  CREATE UNIQUE INDEX "stripe_events_event_id_idx" ON "stripe_events" USING btree ("event_id");
  ALTER TABLE "stripe_events" DROP COLUMN "claim_key";`)
}
