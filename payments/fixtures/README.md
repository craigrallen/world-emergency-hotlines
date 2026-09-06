# Synthetic fixtures

Every identifier here is reserved synthetic data (`*_synthetic*`, `livemode:false`, a fixed 2038 timestamp). Nothing derives from a real Stripe account, customer, or payment. The test suite signs `events/*.json` with a synthetic webhook secret; `node src/cli.mjs sign-test-event --file fixtures/events/checkout.session.completed.synthetic.json` reproduces a valid `Stripe-Signature` header for local curl testing.
