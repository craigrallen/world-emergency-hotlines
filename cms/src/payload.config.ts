import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig, type Config, type Payload } from 'payload';
import { postgresAdapter } from '@payloadcms/db-postgres';
import { sqliteAdapter } from '@payloadcms/db-sqlite';
import { nodemailerAdapter } from '@payloadcms/email-nodemailer';
import { stripePlugin } from '@payloadcms/plugin-stripe';
import { INTERNAL_CONTEXT } from './access';
import { ApiKeys } from './collections/ApiKeys';
import { Entitlements } from './collections/Entitlements';
import { Plans } from './collections/Plans';
import { StripeEvents } from './collections/StripeEvents';
import { Subscriptions } from './collections/Subscriptions';
import { Users } from './collections/Users';
import { accountEndpoints } from './endpoints/account';
import { gatewayEndpoints } from './endpoints/gateway';
import { describeEnv, getEnv } from './env';
import { stripeWebhookHandlers } from './lib/stripe';
import { migrations } from './migrations';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const env = getEnv();

// Postgres is the production database (migrations in src/migrations run on start).
// SQLite is for local development and tests, where the schema is pushed on boot.
const db = env.databaseKind === 'postgres'
  ? postgresAdapter({ pool: { connectionString: env.databaseUrl }, prodMigrations: migrations })
  : sqliteAdapter({ client: { url: env.databaseUrl } });

/** First boot on an empty database: create the admin named by CMS_ADMIN_EMAIL/PASSWORD. */
async function bootstrapAdmin(payload: Payload): Promise<void> {
  if (!env.bootstrapAdmin || env.building) return;
  const existing = await payload.count({ collection: 'users', overrideAccess: true });
  if (existing.totalDocs > 0) return;
  await payload.create({ collection: 'users', data: { email: env.bootstrapAdmin.email, password: env.bootstrapAdmin.password, role: 'admin', name: 'Administrator' }, overrideAccess: true, context: { ...INTERNAL_CONTEXT } });
  payload.logger.info('bootstrap admin account created from CMS_ADMIN_EMAIL');
}

const config: Config = {
  serverURL: env.siteUrl,
  routes: { admin: '/admin', api: '/cms/api' },
  admin: {
    user: Users.slug,
    importMap: { baseDir: path.resolve(dirname) },
    meta: { titleSuffix: ' · World Hotlines CMS' },
    dateFormat: 'yyyy-MM-dd HH:mm',
  },
  collections: [Users, Plans, Subscriptions, Entitlements, StripeEvents, ApiKeys],
  endpoints: [...accountEndpoints, ...gatewayEndpoints],
  cors: [env.siteUrl],
  csrf: [env.siteUrl],
  graphQL: { disable: true },
  secret: env.payloadSecret,
  telemetry: false,
  db,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  plugins: env.stripeSecretKey && env.stripeWebhookSecret
    ? [stripePlugin({ stripeSecretKey: env.stripeSecretKey, stripeWebhooksEndpointSecret: env.stripeWebhookSecret, isTestKey: env.stripeMode === 'test', rest: false, logs: false, webhooks: stripeWebhookHandlers })]
    : [],
  onInit: async (payload) => {
    payload.logger.info({ cms: describeEnv(env) }, 'world hotlines cms ready');
    await bootstrapAdmin(payload);
  },
};

if (env.smtpUrl) {
  config.email = nodemailerAdapter({ defaultFromAddress: env.fromAddress, defaultFromName: env.fromName, transportOptions: { url: env.smtpUrl } as never });
}

export default buildConfig(config);
