import type http from 'node:http';
import { getStripe } from '../src/lib/stripe';
import Stripe from 'stripe';
import type { Payload } from 'payload';
import { REST_DELETE, REST_GET, REST_PATCH, REST_POST } from '@payloadcms/next/routes';
import configPromise from '@payload-config';
import { createCmsStore } from '../../payments/src/cms-store.mjs';

export const SITE = 'http://localhost:8080';
export const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET as string;

const handlers = { GET: REST_GET(configPromise), POST: REST_POST(configPromise), PATCH: REST_PATCH(configPromise), DELETE: REST_DELETE(configPromise) };

export interface CallOptions { method?: keyof typeof handlers; body?: unknown; rawBody?: string; headers?: Record<string, string>; token?: string | null; apiKey?: string | null; origin?: string | null }

/** Drive the real Payload REST router exactly as Next.js would, including custom endpoints and access control. */
export async function call(path: string, { method = 'GET', body, rawBody, headers = {}, token = null, apiKey = null, origin = SITE }: CallOptions = {}) {
  const url = new URL(path, SITE);
  const slug = url.pathname.replace(/^\/cms\/api\//, '').split('/').filter(Boolean);
  const init: RequestInit = { method, headers: { accept: 'application/json', ...headers } };
  if (origin) (init.headers as Record<string, string>).origin = origin;
  if (token) (init.headers as Record<string, string>).authorization = `JWT ${token}`;
  if (apiKey) (init.headers as Record<string, string>).authorization = `users API-Key ${apiKey}`;
  if (rawBody !== undefined) { init.body = rawBody; (init.headers as Record<string, string>)['content-type'] ??= 'application/json'; }
  else if (body !== undefined) { init.body = JSON.stringify(body); (init.headers as Record<string, string>)['content-type'] = 'application/json'; }
  const response = await handlers[method](new Request(url, init), { params: Promise.resolve({ slug }) });
  let data: unknown = null;
  try { data = await response.clone().json(); } catch { data = null; }
  return { status: response.status, headers: response.headers, data: data as Record<string, unknown> & { [key: string]: any } };
}

export async function login(email: string, password: string): Promise<string> {
  const result = await call('/cms/api/users/login', { method: 'POST', body: { email, password } });
  if (result.status !== 200 || typeof result.data?.token !== 'string') throw new Error(`login failed for ${email}: ${result.status} ${JSON.stringify(result.data)}`);
  return result.data.token as string;
}

export async function createUser(payload: Payload, data: Record<string, unknown>) {
  return payload.create({ collection: 'users', data: data as never, overrideAccess: true, context: { cmsInternal: true } });
}

/** Sign a synthetic Stripe event the way Stripe would for the configured endpoint secret. */
export function signEvent(event: Record<string, unknown>, secret = WEBHOOK_SECRET): { body: string; signature: string } {
  const body = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
  return { body, signature };
}

let counter = 0;
export function stripeEvent(type: string, object: Record<string, unknown>, { created = 2145916800, livemode = false, id }: { created?: number; livemode?: boolean; id?: string } = {}) {
  counter += 1;
  return { id: id ?? `evt_synthetic${String(counter).padStart(8, '0')}`, object: 'event', type, livemode, created, api_version: '2026-08-26.dahlia', pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object } };
}

/**
 * Minimal Stripe API double for the three calls the CMS makes. Records requests so
 * tests can assert on customer creation, checkout session parameters, and portal URLs.
 */
export async function startMockStripe() {
  const requests: { method: string; path: string; body: URLSearchParams; headers: http.IncomingHttpHeaders }[] = [];
  /** Objects served for GET /v1/... retrievals (same-second tie reconciliation), keyed by path. */
  const objects = new Map<string, unknown>();
  let customers = 0, sessions = 0, portals = 0;
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const req = { method: init.method, url: url.pathname, headers: Object.fromEntries(new Headers(init.headers).entries()) };
    const body = new URLSearchParams(String(init.body ?? ''));
    requests.push({ method: req.method ?? '', path: req.url, body, headers: req.headers });
    const send = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_synthetic' } });
    if (!String(req.headers.authorization).startsWith('Bearer sk_test_')) return send(401, { error: { type: 'invalid_request_error', message: 'unauthorized' } });
    if (req.method === 'POST' && req.url === '/v1/customers') { customers += 1; return send(200, { id: `cus_synthetic${String(customers).padStart(8, '0')}`, object: 'customer', email: body.get('email') }); }
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      sessions += 1;
      if (body.get('line_items[0][price]') === 'price_synthetic_broken') return send(400, { error: { type: 'invalid_request_error', message: 'No such price' } });
      const id = `cs_test_synthetic${String(sessions).padStart(8, '0')}`;
      return send(200, { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, mode: body.get('mode'), customer: body.get('customer') });
    }
    if (req.method === 'GET' && objects.has(req.url ?? '')) return send(200, objects.get(req.url ?? ''));
    if (req.method === 'POST' && req.url === '/v1/billing_portal/sessions') { portals += 1; return send(200, { id: `bps_synthetic${portals}`, object: 'billing_portal.session', url: `https://billing.stripe.com/p/session/synthetic${portals}` }); }
    return send(404, { error: { type: 'invalid_request_error', message: `unknown route ${req.method} ${req.url}` } });
  };
  // Test-only transport injection; all request encoding, parsing, errors and signatures still use the SDK.
  const client = getStripe() as unknown as { _setApiField(key: string, value: unknown): void };
  client._setApiField('httpClient', Stripe.createFetchHttpClient(fetchMock));
  return { requests, objects, close: async () => {} };
}

/** The real payments adapter talking to Payload's REST router, without a network listener. */
export function paymentsStore(apiKey: string) {
  const options = { url: 'http://localhost:3000/cms/api', apiKey, fetchImpl: async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await call(url.pathname + url.search, { method: init.method as 'POST', apiKey, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(response.data, { status: response.status });
  } };
  return createCmsStore(options);
}
