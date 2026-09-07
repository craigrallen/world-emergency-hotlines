import http from 'node:http';
import Stripe from 'stripe';
import type { Payload } from 'payload';
import { REST_DELETE, REST_GET, REST_PATCH, REST_POST } from '@payloadcms/next/routes';
import configPromise from '@payload-config';

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
export async function startMockStripe(port = 12111) {
  const requests: { method: string; path: string; body: URLSearchParams; headers: http.IncomingHttpHeaders }[] = [];
  /** Objects served for GET /v1/... retrievals (same-second tie reconciliation), keyed by path. */
  const objects = new Map<string, unknown>();
  let customers = 0, sessions = 0, portals = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = new URLSearchParams(raw);
      requests.push({ method: req.method ?? '', path: req.url ?? '', body, headers: req.headers });
      const send = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_synthetic' }); res.end(JSON.stringify(payload)); };
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
    });
  });
  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', () => ok()));
  return { requests, objects, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}
