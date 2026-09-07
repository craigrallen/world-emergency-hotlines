// Fail-closed environment parsing for the CMS.
//
// Every variable is validated once at config-build time. Secret values never
// appear in error messages: errors name the variable and the rule it broke.
// During `next build` (NEXT_PHASE=phase-production-build) no secrets exist, so a
// clearly-labelled placeholder secret is used; at runtime a missing or short
// PAYLOAD_SECRET stops the process before it can serve a request.

export type StripeMode = 'disabled' | 'test' | 'live';
export type Registration = 'open' | 'closed';

export interface CmsEnv {
  readonly building: boolean;
  readonly nodeEnv: string;
  readonly payloadSecret: string;
  readonly databaseUrl: string;
  readonly databaseKind: 'postgres' | 'sqlite';
  readonly siteUrl: string;
  readonly cookieSecure: boolean;
  readonly registration: Registration;
  readonly requireEmailVerification: boolean;
  readonly smtpUrl: string | null;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly stripeMode: StripeMode;
  readonly stripeSecretKey: string | null;
  readonly stripeWebhookSecret: string | null;
  readonly stripeApiBase: string | null;
  readonly gatewayKeyPepper: string | null;
  readonly maxApiKeysPerUser: number;
  readonly bootstrapAdmin: { email: string; password: string } | null;
}

export const BUILD_PLACEHOLDER_SECRET = 'build-phase-placeholder-secret-not-for-runtime-use-0000';
export const STRIPE_SECRET_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/;
export const STRIPE_WEBHOOK_SECRET = /^whsec_[A-Za-z0-9]{16,}$/;
export const KNOWN_VARIABLES = Object.freeze([
  'PAYLOAD_SECRET', 'DATABASE_URL', 'PUBLIC_SITE_URL',
  'CMS_ACCOUNTS_REGISTRATION', 'CMS_REQUIRE_EMAIL_VERIFICATION', 'CMS_MAX_API_KEYS_PER_USER',
  'CMS_ADMIN_EMAIL', 'CMS_ADMIN_PASSWORD', 'CMS_STRIPE_API_BASE',
  'SMTP_URL', 'SMTP_FROM_ADDRESS', 'SMTP_FROM_NAME',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'GATEWAY_KEY_PEPPER',
]);

export class EnvError extends Error {
  readonly variable: string;
  constructor(variable: string, reason: string) {
    super(`invalid CMS configuration: ${variable} ${reason}`);
    this.name = 'EnvError';
    this.variable = variable;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

/** Exact origin: https anywhere, http only on loopback. No path, query, fragment, or credentials. */
export function validOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 255 || value.endsWith('/')) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) return false;
  if (url.origin !== value) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
}

function flag(source: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const value = source[name];
  if (value === undefined || value === '') return fallback;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new EnvError(name, 'must be 0, 1, true, or false');
}

/** Variables with a default or an "off" meaning: an empty string (as Compose and Railway pass unset values) means not configured. */
export const OPTIONAL_VARIABLES = Object.freeze([
  'DATABASE_URL', 'PUBLIC_SITE_URL', 'CMS_ACCOUNTS_REGISTRATION', 'CMS_REQUIRE_EMAIL_VERIFICATION', 'CMS_MAX_API_KEYS_PER_USER',
  'CMS_ADMIN_EMAIL', 'CMS_ADMIN_PASSWORD', 'CMS_STRIPE_API_BASE', 'SMTP_URL', 'SMTP_FROM_ADDRESS', 'SMTP_FROM_NAME',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'GATEWAY_KEY_PEPPER',
]);

export function readEnv(raw: NodeJS.ProcessEnv = process.env): CmsEnv {
  const source = Object.fromEntries(Object.entries(raw).filter(([name, value]) => !(OPTIONAL_VARIABLES.includes(name) && value === ''))) as unknown as NodeJS.ProcessEnv;
  for (const name of Object.keys(source)) {
    if ((name.startsWith('CMS_') || name.startsWith('STRIPE_') || name.startsWith('SMTP_') || name.startsWith('GATEWAY_')) && !KNOWN_VARIABLES.includes(name)) {
      throw new EnvError(name, 'is not a recognised variable');
    }
  }
  const building = source.NEXT_PHASE === 'phase-production-build';
  const nodeEnv = source.NODE_ENV ?? 'development';

  const secret = source.PAYLOAD_SECRET;
  let payloadSecret: string;
  if (typeof secret === 'string' && secret.length >= 32 && secret.length <= 512 && !/\s/.test(secret)) payloadSecret = secret;
  else if (building && (secret === undefined || secret === '')) payloadSecret = BUILD_PLACEHOLDER_SECRET;
  else throw new EnvError('PAYLOAD_SECRET', 'must be a random string of 32 to 512 characters');

  const databaseUrl = source.DATABASE_URL ?? 'file:./data/cms.db';
  let databaseKind: CmsEnv['databaseKind'];
  if (/^postgres(?:ql)?:\/\/\S+$/.test(databaseUrl)) databaseKind = 'postgres';
  else if (/^file:\S+$/.test(databaseUrl) || databaseUrl === ':memory:') databaseKind = 'sqlite';
  else throw new EnvError('DATABASE_URL', 'must be a postgres:// URL or a file: SQLite URL');
  if (databaseKind === 'sqlite' && nodeEnv === 'production' && !building) throw new EnvError('DATABASE_URL', 'must be a postgres:// URL in production; SQLite is for development and tests only');

  const siteUrl = source.PUBLIC_SITE_URL ?? 'https://worldhotlines.org';
  if (!validOrigin(siteUrl)) throw new EnvError('PUBLIC_SITE_URL', 'must be an exact https origin (or a loopback http origin for local development)');
  const cookieSecure = siteUrl.startsWith('https://');

  const registration = source.CMS_ACCOUNTS_REGISTRATION ?? 'closed';
  if (registration !== 'open' && registration !== 'closed') throw new EnvError('CMS_ACCOUNTS_REGISTRATION', 'must be open or closed');
  const requireEmailVerification = flag(source, 'CMS_REQUIRE_EMAIL_VERIFICATION');

  const smtpUrl = source.SMTP_URL ?? null;
  if (smtpUrl !== null && !/^smtps?:\/\/\S+$/.test(smtpUrl)) throw new EnvError('SMTP_URL', 'must be an smtp:// or smtps:// URL');
  if (requireEmailVerification && smtpUrl === null && nodeEnv === 'production' && !building) throw new EnvError('CMS_REQUIRE_EMAIL_VERIFICATION', 'needs SMTP_URL so verification emails can actually be delivered');
  const fromAddress = source.SMTP_FROM_ADDRESS ?? 'no-reply@worldhotlines.org';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress)) throw new EnvError('SMTP_FROM_ADDRESS', 'must be an email address');
  const fromName = source.SMTP_FROM_NAME ?? 'World Hotlines';
  if (fromName.length < 1 || fromName.length > 80) throw new EnvError('SMTP_FROM_NAME', 'must be 1 to 80 characters');

  const stripeSecretKey = source.STRIPE_SECRET_KEY ?? null;
  let stripeMode: StripeMode = 'disabled';
  let stripeWebhookSecret: string | null = null;
  if (stripeSecretKey !== null) {
    const match = STRIPE_SECRET_KEY.exec(stripeSecretKey);
    if (!match) throw new EnvError('STRIPE_SECRET_KEY', 'must be a Stripe secret or restricted key');
    stripeMode = match[2] as StripeMode;
    stripeWebhookSecret = source.STRIPE_WEBHOOK_SECRET ?? null;
    if (stripeWebhookSecret === null || !STRIPE_WEBHOOK_SECRET.test(stripeWebhookSecret)) throw new EnvError('STRIPE_WEBHOOK_SECRET', 'must be the webhook endpoint signing secret when STRIPE_SECRET_KEY is set');
    if (stripeMode === 'live' && !siteUrl.startsWith('https://')) throw new EnvError('PUBLIC_SITE_URL', 'must be https when a live Stripe key is configured');
  } else if (source.STRIPE_WEBHOOK_SECRET !== undefined) {
    throw new EnvError('STRIPE_WEBHOOK_SECRET', 'is only accepted together with STRIPE_SECRET_KEY');
  }
  const stripeApiBase = source.CMS_STRIPE_API_BASE ?? null;
  if (stripeApiBase !== null) {
    let url: URL | null = null;
    try { url = new URL(stripeApiBase); } catch { url = null; }
    if (!url || url.protocol !== 'http:' || !isLoopbackHost(url.hostname) || url.pathname !== '/' || url.search || url.hash) throw new EnvError('CMS_STRIPE_API_BASE', 'must be a loopback http origin (test double only)');
    if (stripeMode === 'live') throw new EnvError('CMS_STRIPE_API_BASE', 'cannot be combined with a live Stripe key');
  }

  const gatewayKeyPepper = source.GATEWAY_KEY_PEPPER ?? null;
  if (gatewayKeyPepper !== null && (gatewayKeyPepper.length < 32 || gatewayKeyPepper.length > 4096 || /\s/.test(gatewayKeyPepper))) throw new EnvError('GATEWAY_KEY_PEPPER', 'must be an independently generated secret of at least 32 characters');

  const maxKeysRaw = source.CMS_MAX_API_KEYS_PER_USER ?? '5';
  if (!/^\d{1,3}$/.test(maxKeysRaw) || Number(maxKeysRaw) < 1 || Number(maxKeysRaw) > 100) throw new EnvError('CMS_MAX_API_KEYS_PER_USER', 'must be an integer from 1 to 100');

  let bootstrapAdmin: CmsEnv['bootstrapAdmin'] = null;
  if (source.CMS_ADMIN_EMAIL !== undefined || source.CMS_ADMIN_PASSWORD !== undefined) {
    const email = source.CMS_ADMIN_EMAIL ?? '';
    const password = source.CMS_ADMIN_PASSWORD ?? '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new EnvError('CMS_ADMIN_EMAIL', 'must be an email address when bootstrap credentials are set');
    if (password.length < 12 || password.length > 256) throw new EnvError('CMS_ADMIN_PASSWORD', 'must be 12 to 256 characters when bootstrap credentials are set');
    bootstrapAdmin = { email, password };
  }

  return Object.freeze({
    building, nodeEnv, payloadSecret, databaseUrl, databaseKind, siteUrl, cookieSecure, registration, requireEmailVerification,
    smtpUrl, fromAddress, fromName, stripeMode, stripeSecretKey, stripeWebhookSecret, stripeApiBase, gatewayKeyPepper,
    maxApiKeysPerUser: Number(maxKeysRaw), bootstrapAdmin,
  });
}

/** Secret-free summary for logs and the status endpoint. */
export function describeEnv(env: CmsEnv) {
  return {
    database: env.databaseKind,
    site_url: env.siteUrl,
    registration: env.registration,
    email_verification: env.requireEmailVerification,
    smtp_configured: env.smtpUrl !== null,
    stripe_mode: env.stripeMode,
    stripe_webhook_configured: env.stripeWebhookSecret !== null,
    gateway_key_issuance: env.gatewayKeyPepper !== null,
    max_api_keys_per_user: env.maxApiKeysPerUser,
    bootstrap_admin_configured: env.bootstrapAdmin !== null,
  };
}

let cached: CmsEnv | null = null;
export function getEnv(): CmsEnv {
  if (!cached) cached = readEnv();
  return cached;
}
/** Test helper: forget the cached environment so a test can re-read process.env. */
export function resetEnvCache(): void { cached = null; }
