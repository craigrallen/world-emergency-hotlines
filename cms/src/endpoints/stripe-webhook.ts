import type Stripe from 'stripe';
import type { Endpoint } from 'payload';
import { getEnv } from '../env';
import { EndpointError, fail, json } from '../lib/responses';
import { getStripe, handleStripeEvent } from '../lib/stripe';

export const STRIPE_WEBHOOK_PATH = '/stripe/webhooks';
/** Stripe events are small; this bound only stops abuse of the unauthenticated route. */
export const MAX_WEBHOOK_BODY_BYTES = 262144;

/**
 * Signed Stripe webhook at `/cms/api/stripe/webhooks`.
 *
 * The response is decided by the outcome, which is what lets Stripe retry: a
 * signature that does not verify is 400, a handler failure is 500 after the event's
 * claim has been released, an event whose earlier delivery is still in progress is
 * 409, and everything else (processed, duplicate, stale, ignored) is 200. Stripe
 * retries non-2xx deliveries automatically for days, so a transient database error
 * never leaves an account stale behind a 2xx.
 */
export const stripeWebhookEndpoint: Endpoint = {
  path: STRIPE_WEBHOOK_PATH,
  method: 'post',
  handler: async (req) => {
    const env = getEnv();
    const stripe = getStripe();
    if (!stripe || !env.stripeWebhookSecret) return fail(req, 'stripe_disabled');
    const signature = req.headers.get('stripe-signature');
    if (!signature || signature.length > 4096) return fail(req, 'signature_invalid');
    let body: string;
    try { body = await readWebhookBody(req); } catch (error) { return fail(req, error instanceof EndpointError ? error.code : 'invalid_request'); }
    if (!body) return fail(req, 'invalid_request');
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(body, signature, env.stripeWebhookSecret);
    } catch {
      req.payload.logger.warn('stripe webhook signature did not verify');
      return fail(req, 'signature_invalid');
    }
    const outcome = await handleStripeEvent(req.payload, event);
    if (outcome === 'handler_failed') return fail(req, 'handler_failed');
    // Another delivery of this event is still being applied (or died without cleaning
    // up); a non-2xx keeps Stripe retrying until the claim completes or can be taken over.
    if (outcome === 'in_progress') return fail(req, 'event_in_progress');
    return json(req, 200, { received: true, outcome });
  },
};

/** Never call text()/arrayBuffer(): count bytes before retaining each stream chunk. */
export async function readWebhookBody(req: { headers: Headers; body?: ReadableStream<Uint8Array> | null }): Promise<string> {
  const length = req.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_WEBHOOK_BODY_BYTES)) throw new EndpointError('payload_too_large');
  if (!req.body) throw new EndpointError('invalid_request');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WEBHOOK_BODY_BYTES) { await reader.cancel(); throw new EndpointError('payload_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}
