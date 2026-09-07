// Test environment: SQLite file database, Stripe test key pointed at the in-process
// mock (see test/helpers.ts), registration open, gateway key issuance on. Values are
// synthetic; none of them is Stripe material (the repeated-character bodies fail the
// entropy check in web/scripts/verify-payments-foundation.mjs on purpose).
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const dataDir = resolve(import.meta.dirname, '../data');
mkdirSync(dataDir, { recursive: true });
const dbFile = resolve(dataDir, `test-${process.pid}.db`);
for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true });

process.env.PAYLOAD_SECRET = 'vitest-only-payload-secret-that-is-long-enough-0000';
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.PUBLIC_SITE_URL = 'http://localhost:8080';
process.env.CMS_ACCOUNTS_REGISTRATION = 'open';
process.env.CMS_REQUIRE_EMAIL_VERIFICATION = '0';
process.env.CMS_MAX_API_KEYS_PER_USER = '2';
process.env.STRIPE_SECRET_KEY = `sk_test_${'a'.repeat(40)}`;
process.env.STRIPE_WEBHOOK_SECRET = `whsec_${'b'.repeat(32)}`;
process.env.CMS_STRIPE_API_BASE = process.env.CMS_STRIPE_API_BASE ?? 'http://127.0.0.1:12111';
process.env.GATEWAY_KEY_PEPPER = 'vitest-only-gateway-pepper-with-at-least-32-chars';
delete process.env.SMTP_URL;
delete process.env.CMS_ADMIN_EMAIL;
delete process.env.CMS_ADMIN_PASSWORD;
