import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_users_service_scope" AS ENUM('payments_store', 'gateway_sync');
  ALTER TABLE "users" ADD COLUMN "service_scope" "enum_users_service_scope";`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" DROP COLUMN "service_scope";
  DROP TYPE "public"."enum_users_service_scope";`)
}
