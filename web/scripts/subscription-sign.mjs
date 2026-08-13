#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { signature, verifySignature } from './subscription-events.mjs';

const [command, bodyPath, timestamp, provided] = process.argv.slice(2);
const secret = process.env.WEH_SYNTHETIC_WEBHOOK_SECRET;
const integerEnv = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be a strict non-negative safe Unix integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a strict non-negative safe Unix integer`);
  return parsed;
};

if (!secret || !bodyPath || !timestamp) { console.error('usage: WEH_SYNTHETIC_WEBHOOK_SECRET=<32-byte-base64url> node subscription-sign.mjs sign|verify BODY TIMESTAMP [SIGNATURE]'); process.exit(2); }
if (command === 'sign') console.log(signature(timestamp, readFileSync(bodyPath), secret));
else if (command === 'verify') {
  try {
    const previousValue = process.env.WEH_SYNTHETIC_WEBHOOK_PREVIOUS_SECRET;
    const previousMetadataPresent = process.env.WEH_SYNTHETIC_WEBHOOK_PREVIOUS_ACTIVATED_AT != null || process.env.WEH_SYNTHETIC_WEBHOOK_PREVIOUS_EXPIRES_AT != null;
    if (!previousValue && previousMetadataPresent) throw new Error('previous-secret timestamps require WEH_SYNTHETIC_WEBHOOK_PREVIOUS_SECRET');
    const previous = previousValue ? {
      value: previousValue,
      activated_at: integerEnv('WEH_SYNTHETIC_WEBHOOK_PREVIOUS_ACTIVATED_AT'),
      expires_at: integerEnv('WEH_SYNTHETIC_WEBHOOK_PREVIOUS_EXPIRES_AT'),
    } : undefined;
    const result = verifySignature({ timestamp, rawBody: readFileSync(bodyPath), signatureHeader: provided, secrets: { current: { value: secret }, ...(previous ? { previous } : {}) }, now: integerEnv('WEH_SYNTHETIC_NOW', timestamp) });
    console.log(result.ok ? 'verified' : `rejected:${result.reason}`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`configuration error: ${error.message}`);
    process.exitCode = 2;
  }
} else { console.error('command must be sign or verify'); process.exit(2); }
