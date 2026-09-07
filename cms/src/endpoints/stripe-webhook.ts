import type Stripe from 'stripe';
import type { Endpoint } from 'payload';
import { getEnv } from '../env';
import { fail, json } from '../lib/responses';
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
    const length = req.headers.get('content-length');
    if (length !== null && (!/^\d{1,7}$/.test(length) || Number(length) > MAX_WEBHOOK_BODY_BYTES)) return fail(req, 'invalid_request');
    let body: string;
    try { body = typeof req.text === 'function' ? await req.text() : ''; } catch { return fail(req, 'invalid_request'); }
    if (!body || body.length > MAX_WEBHOOK_BODY_BYTES) return fail(req, 'invalid_request');
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
