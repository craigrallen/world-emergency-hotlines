import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig, type Config } from 'payload';
import { postgresAdapter } from '@payloadcms/db-postgres';
import { sqliteAdapter } from '@payloadcms/db-sqlite';
import { nodemailerAdapter } from '@payloadcms/email-nodemailer';
import { bootstrapAdmin } from './lib/bootstrap';
import { ApiKeys } from './collections/ApiKeys';
import { Entitlements } from './collections/Entitlements';
import { Plans } from './collections/Plans';
import { StripeEvents } from './collections/StripeEvents';
import { Subscriptions } from './collections/Subscriptions';
import { Users } from './collections/Users';
import { accountEndpoints } from './endpoints/account';
import { gatewayEndpoints } from './endpoints/gateway';
import { stripeWebhookEndpoint } from './endpoints/stripe-webhook';
import { describeEnv, getEnv } from './env';
import { migrations } from './migrations';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const env = getEnv();

// Postgres is the production database (migrations in src/migrations run on start).
// SQLite is for local development and tests, where the schema is pushed on boot.
const db = env.databaseKind === 'postgres'
  ? postgresAdapter({ pool: { connectionString: env.databaseUrl }, prodMigrations: migrations, push: false })
  : sqliteAdapter({ client: { url: env.databaseUrl } });

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
  // The Stripe webhook is a first-class endpoint (not the plugin route) so its
  // response can be non-2xx when handling fails and Stripe retries the delivery.
  endpoints: [...accountEndpoints, ...gatewayEndpoints, stripeWebhookEndpoint],
  cors: [env.siteUrl],
  csrf: [env.siteUrl],
  graphQL: { disable: true },
  secret: env.payloadSecret,
  telemetry: false,
  db,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  onInit: async (payload) => {
    await bootstrapAdmin(payload, env);
    payload.logger.info({ cms: describeEnv(env) }, 'world hotlines cms ready');
  },
};

if (env.smtpUrl) {
  config.email = nodemailerAdapter({ defaultFromAddress: env.fromAddress, defaultFromName: env.fromName, transportOptions: { url: env.smtpUrl } as never });
}

export default buildConfig(config);
