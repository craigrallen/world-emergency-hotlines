import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_users_role" AS ENUM('admin', 'staff', 'member', 'service');
  CREATE TYPE "public"."enum_plans_gateway_permissions" AS ENUM('manifest', 'records', 'resolver');
  CREATE TYPE "public"."enum_plans_mode" AS ENUM('subscription', 'payment');
  CREATE TYPE "public"."enum_subscriptions_status" AS ENUM('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'pending_subscription_event', 'unknown');
  CREATE TYPE "public"."enum_subscriptions_last_invoice_status" AS ENUM('paid', 'payment_failed');
  CREATE TYPE "public"."enum_subscriptions_source" AS ENUM('cms', 'payments');
  CREATE TYPE "public"."enum_entitlements_kind" AS ENUM('checkout_session', 'subscription', 'unknown');
  CREATE TYPE "public"."enum_stripe_events_source" AS ENUM('payments', 'cms');
  CREATE TYPE "public"."enum_api_keys_permissions" AS ENUM('manifest', 'records', 'resolver');
  CREATE TYPE "public"."enum_api_keys_state" AS ENUM('active', 'revoked', 'expired');
  CREATE TABLE "users_sessions" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"created_at" timestamp(3) with time zone,
  	"expires_at" timestamp(3) with time zone NOT NULL
  );
  
  CREATE TABLE "users" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"role" "enum_users_role" DEFAULT 'member' NOT NULL,
  	"stripe_customer_id" varchar,
  	"notes" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"enable_a_p_i_key" boolean,
  	"api_key" varchar,
  	"api_key_index" varchar,
  	"email" varchar NOT NULL,
  	"reset_password_token" varchar,
  	"reset_password_expiration" timestamp(3) with time zone,
  	"salt" varchar,
  	"hash" varchar,
  	"login_attempts" numeric DEFAULT 0,
  	"lock_until" timestamp(3) with time zone
  );
  
  CREATE TABLE "plans_gateway_permissions" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_plans_gateway_permissions",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "plans" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"offer_id" varchar NOT NULL,
  	"label" varchar NOT NULL,
  	"description" varchar,
  	"mode" "enum_plans_mode" DEFAULT 'subscription' NOT NULL,
  	"stripe_price_id" varchar NOT NULL,
  	"quantity" numeric DEFAULT 1 NOT NULL,
  	"active" boolean DEFAULT false,
  	"gateway_quota_rate" numeric DEFAULT 1 NOT NULL,
  	"gateway_quota_burst" numeric DEFAULT 10 NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "subscriptions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"stripe_subscription_id" varchar NOT NULL,
  	"stripe_customer_id" varchar,
  	"user_id" integer,
  	"plan_id" integer,
  	"offer" varchar,
  	"status" "enum_subscriptions_status" DEFAULT 'unknown' NOT NULL,
  	"cancel_at_period_end" boolean DEFAULT false,
  	"current_period_end" timestamp(3) with time zone,
  	"livemode" boolean DEFAULT false,
  	"checkout_session_id" varchar,
  	"last_invoice_id" varchar,
  	"last_invoice_status" "enum_subscriptions_last_invoice_status",
  	"last_event_created" numeric,
  	"last_event_id" varchar,
  	"source" "enum_subscriptions_source" DEFAULT 'cms' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "entitlements" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"kind" "enum_entitlements_kind" DEFAULT 'unknown' NOT NULL,
  	"offer" varchar,
  	"offer_known" boolean DEFAULT false,
  	"status" varchar DEFAULT 'unknown' NOT NULL,
  	"customer" varchar,
  	"subscription" varchar,
  	"checkout_session" varchar,
  	"payment_intent" varchar,
  	"livemode" boolean DEFAULT false,
  	"updated_at_epoch" numeric,
  	"source_event" varchar,
  	"source" varchar DEFAULT 'payments' NOT NULL,
  	"record" jsonb NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "stripe_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"event_id" varchar NOT NULL,
  	"type" varchar,
  	"livemode" boolean DEFAULT false,
  	"source" "enum_stripe_events_source" DEFAULT 'payments' NOT NULL,
  	"outcome" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "api_keys_permissions" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_api_keys_permissions",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "api_keys" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key_id" varchar NOT NULL,
  	"verifier" varchar NOT NULL,
  	"user_id" integer NOT NULL,
  	"label" varchar,
  	"state" "enum_api_keys_state" DEFAULT 'active' NOT NULL,
  	"not_before" timestamp(3) with time zone,
  	"expires_at" timestamp(3) with time zone,
  	"revoked_at" timestamp(3) with time zone,
  	"quota_rate" numeric DEFAULT 1 NOT NULL,
  	"quota_burst" numeric DEFAULT 10 NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_kv" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"data" jsonb NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"global_slug" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer,
  	"plans_id" integer,
  	"subscriptions_id" integer,
  	"entitlements_id" integer,
  	"stripe_events_id" integer,
  	"api_keys_id" integer
  );
  
  CREATE TABLE "payload_preferences" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar,
  	"value" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_preferences_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "payload_migrations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"batch" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "users_sessions" ADD CONSTRAINT "users_sessions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "plans_gateway_permissions" ADD CONSTRAINT "plans_gateway_permissions_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "api_keys_permissions" ADD CONSTRAINT "api_keys_permissions_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_plans_fk" FOREIGN KEY ("plans_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_subscriptions_fk" FOREIGN KEY ("subscriptions_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_entitlements_fk" FOREIGN KEY ("entitlements_id") REFERENCES "public"."entitlements"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_stripe_events_fk" FOREIGN KEY ("stripe_events_id") REFERENCES "public"."stripe_events"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_api_keys_fk" FOREIGN KEY ("api_keys_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "users_sessions_order_idx" ON "users_sessions" USING btree ("_order");
  CREATE INDEX "users_sessions_parent_id_idx" ON "users_sessions" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "users_stripe_customer_id_idx" ON "users" USING btree ("stripe_customer_id");
  CREATE INDEX "users_updated_at_idx" ON "users" USING btree ("updated_at");
  CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");
  CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");
  CREATE INDEX "plans_gateway_permissions_order_idx" ON "plans_gateway_permissions" USING btree ("order");
  CREATE INDEX "plans_gateway_permissions_parent_idx" ON "plans_gateway_permissions" USING btree ("parent_id");
  CREATE UNIQUE INDEX "plans_offer_id_idx" ON "plans" USING btree ("offer_id");
  CREATE INDEX "plans_updated_at_idx" ON "plans" USING btree ("updated_at");
  CREATE INDEX "plans_created_at_idx" ON "plans" USING btree ("created_at");
  CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_idx" ON "subscriptions" USING btree ("stripe_subscription_id");
  CREATE INDEX "subscriptions_stripe_customer_id_idx" ON "subscriptions" USING btree ("stripe_customer_id");
  CREATE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id");
  CREATE INDEX "subscriptions_plan_idx" ON "subscriptions" USING btree ("plan_id");
  CREATE INDEX "subscriptions_offer_idx" ON "subscriptions" USING btree ("offer");
  CREATE INDEX "subscriptions_updated_at_idx" ON "subscriptions" USING btree ("updated_at");
  CREATE INDEX "subscriptions_created_at_idx" ON "subscriptions" USING btree ("created_at");
  CREATE UNIQUE INDEX "entitlements_key_idx" ON "entitlements" USING btree ("key");
  CREATE INDEX "entitlements_offer_idx" ON "entitlements" USING btree ("offer");
  CREATE INDEX "entitlements_customer_idx" ON "entitlements" USING btree ("customer");
  CREATE INDEX "entitlements_subscription_idx" ON "entitlements" USING btree ("subscription");
  CREATE INDEX "entitlements_updated_at_idx" ON "entitlements" USING btree ("updated_at");
  CREATE INDEX "entitlements_created_at_idx" ON "entitlements" USING btree ("created_at");
  CREATE UNIQUE INDEX "stripe_events_event_id_idx" ON "stripe_events" USING btree ("event_id");
  CREATE INDEX "stripe_events_updated_at_idx" ON "stripe_events" USING btree ("updated_at");
  CREATE INDEX "stripe_events_created_at_idx" ON "stripe_events" USING btree ("created_at");
  CREATE INDEX "api_keys_permissions_order_idx" ON "api_keys_permissions" USING btree ("order");
  CREATE INDEX "api_keys_permissions_parent_idx" ON "api_keys_permissions" USING btree ("parent_id");
  CREATE UNIQUE INDEX "api_keys_key_id_idx" ON "api_keys" USING btree ("key_id");
  CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");
  CREATE INDEX "api_keys_updated_at_idx" ON "api_keys" USING btree ("updated_at");
  CREATE INDEX "api_keys_created_at_idx" ON "api_keys" USING btree ("created_at");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload_kv" USING btree ("key");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_users_id_idx" ON "payload_locked_documents_rels" USING btree ("users_id");
  CREATE INDEX "payload_locked_documents_rels_plans_id_idx" ON "payload_locked_documents_rels" USING btree ("plans_id");
  CREATE INDEX "payload_locked_documents_rels_subscriptions_id_idx" ON "payload_locked_documents_rels" USING btree ("subscriptions_id");
  CREATE INDEX "payload_locked_documents_rels_entitlements_id_idx" ON "payload_locked_documents_rels" USING btree ("entitlements_id");
  CREATE INDEX "payload_locked_documents_rels_stripe_events_id_idx" ON "payload_locked_documents_rels" USING btree ("stripe_events_id");
  CREATE INDEX "payload_locked_documents_rels_api_keys_id_idx" ON "payload_locked_documents_rels" USING btree ("api_keys_id");
  CREATE INDEX "payload_preferences_key_idx" ON "payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_users_id_idx" ON "payload_preferences_rels" USING btree ("users_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload_migrations" USING btree ("created_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "users_sessions" CASCADE;
  DROP TABLE "users" CASCADE;
  DROP TABLE "plans_gateway_permissions" CASCADE;
  DROP TABLE "plans" CASCADE;
  DROP TABLE "subscriptions" CASCADE;
  DROP TABLE "entitlements" CASCADE;
  DROP TABLE "stripe_events" CASCADE;
  DROP TABLE "api_keys_permissions" CASCADE;
  DROP TABLE "api_keys" CASCADE;
  DROP TABLE "payload_kv" CASCADE;
  DROP TABLE "payload_locked_documents" CASCADE;
  DROP TABLE "payload_locked_documents_rels" CASCADE;
  DROP TABLE "payload_preferences" CASCADE;
  DROP TABLE "payload_preferences_rels" CASCADE;
  DROP TABLE "payload_migrations" CASCADE;
  DROP TYPE "public"."enum_users_role";
  DROP TYPE "public"."enum_plans_gateway_permissions";
  DROP TYPE "public"."enum_plans_mode";
  DROP TYPE "public"."enum_subscriptions_status";
  DROP TYPE "public"."enum_subscriptions_last_invoice_status";
  DROP TYPE "public"."enum_subscriptions_source";
  DROP TYPE "public"."enum_entitlements_kind";
  DROP TYPE "public"."enum_stripe_events_source";
  DROP TYPE "public"."enum_api_keys_permissions";
  DROP TYPE "public"."enum_api_keys_state";`)
}
