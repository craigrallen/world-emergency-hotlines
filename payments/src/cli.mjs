#!/usr/bin/env node
// Commands:
//   serve             start the HTTP service from environment configuration
//   check-config      validate environment configuration and print a secret-free summary
//   sign-test-event   print a Stripe-Signature header for a local payload file
//   inspect           print component identity
import { readFileSync } from 'node:fs';
import { ConfigError, describeConfig, loadConfig } from './config.mjs';
import { createPaymentsServer } from './server.mjs';
import { signTestPayload } from './webhook.mjs';

const [command, ...args] = process.argv.slice(2);
const print = (value) => console.log(JSON.stringify(value, null, 2));

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

if (command === 'serve') {
  let config;
  try { config = loadConfig(process.env); } catch (error) { console.error(error instanceof ConfigError ? error.message : 'payments startup failed'); process.exitCode = 1; }
  if (config) {
    try {
      const service = createPaymentsServer(config, { sink: (event) => console.log(JSON.stringify(event)) });
      const address = await service.listen();
      console.log(JSON.stringify({ event: 'payments_started', address: address.address, port: address.port, ...describeConfig(config) }));
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { try { await service.close(); process.exit(0); } catch { process.exit(1); } });
    } catch { console.error('payments startup failed'); process.exitCode = 1; }
  }
} else if (command === 'check-config') {
  try { print(describeConfig(loadConfig(process.env))); } catch (error) { console.error(error instanceof ConfigError ? error.message : 'payments configuration check failed'); process.exitCode = 1; }
} else if (command === 'sign-test-event') {
  const file = option('--file'), secretEnv = option('--secret-env') ?? 'STRIPE_WEBHOOK_SECRET', timestampRaw = option('--timestamp');
  const secret = process.env[secretEnv];
  const timestamp = timestampRaw === undefined ? Math.floor(Date.now() / 1000) : Number(timestampRaw);
  if (!file || typeof secret !== 'string' || secret.length === 0 || !Number.isInteger(timestamp) || timestamp < 0) { console.error('usage: cli.mjs sign-test-event --file payload.json [--secret-env STRIPE_WEBHOOK_SECRET] [--timestamp unix-seconds]'); process.exitCode = 2; }
  else console.log(signTestPayload({ rawBody: readFileSync(file), secret, timestamp }));
} else if (command === 'inspect') {
  print({ component: 'payments', foundation: true, deployed: false });
} else {
  console.error('usage: cli.mjs serve|check-config|sign-test-event|inspect');
  process.exitCode = 2;
}
