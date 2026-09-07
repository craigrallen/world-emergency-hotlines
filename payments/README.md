# Payments foundation (Stripe) — prepared, not enabled

Dependency-free Node 22 service that creates Stripe hosted Checkout Sessions, opens the Customer Portal, and verifies Stripe webhooks for the World Hotlines site. It is **not deployed** and starts in `PAYMENTS_MODE=disabled`, where every payment route answers 503. Free crisis-information surfaces are unaffected.

- Runbook and activation checklist: [`docs/PAYMENTS.md`](../docs/PAYMENTS.md)
- Contract, routes, privacy boundary: [`contracts/v1/README.md`](contracts/v1/README.md) and [`contracts/v1/openapi.json`](contracts/v1/openapi.json)
- Configuration reference: [`.env.example`](.env.example)

```bash
npm test                          # node --test, no network
node src/cli.mjs check-config     # validates PAYMENTS_*/STRIPE_* variables, prints no secrets
node src/cli.mjs serve            # GET /billing/api/health
node src/cli.mjs sign-test-event --file fixtures/events/checkout.session.completed.synthetic.json
```

Layout: `src/config.mjs` (fail-closed env parsing), `src/stripe.mjs` (REST client), `src/webhook.mjs` (signature verification), `src/events.mjs` (event → entitlement state), `src/store.mjs` (store contract + bounded memory store), `src/server.mjs` (HTTP), `src/cli.mjs`. `Dockerfile` and `railway.toml` describe a separate Railway service whose root directory is this folder.
