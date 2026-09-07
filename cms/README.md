# World Hotlines CMS — prepared, not enabled

Payload 3 on Next.js: member accounts and the `/account` page's backend, user administration at `/admin`, Stripe billing inside the CMS (plans → Stripe price ids, signed webhooks, account-bound hosted Checkout and Customer Portal), and managed API key issuance for the gateway. It is **not deployed**; Caddy answers 503 for its routes until `CMS_UPSTREAM` is set. Free crisis-information surfaces are unaffected and never need an account.

- Runbook and activation checklist: [`docs/ACCOUNTS.md`](../docs/ACCOUNTS.md)
- Configuration reference: [`.env.example`](.env.example)

```bash
npm install
npm run dev                # SQLite at data/cms.db; http://localhost:3000/admin
npm test                   # vitest: SQLite + in-process Stripe double, real REST router
npm run typecheck
npm run generate:types     # after collection changes (CI checks src/payload-types.ts)
npm run migrate:create -- <name>   # Postgres migration for production (no DB connection needed)
npm run build
```

Layout: `src/env.ts` (fail-closed env parsing), `src/access.ts` (roles), `src/collections/` (users, plans, subscriptions, entitlements, stripe-events, api-keys), `src/lib/stripe.ts` (Stripe client + webhook handlers), `src/lib/subscriptions.ts` (idempotent subscription mirror shared by both webhook consumers), `src/lib/gateway-keys.ts` (key records in the gateway contract shape), `src/endpoints/` (`/cms/api/account/*`, `/cms/api/gateway/keys`), `src/app/` (Next.js routes: admin at `/admin`, REST at `/cms/api`). `Dockerfile` and `railway.toml` describe a separate Railway service whose root directory is this folder.
