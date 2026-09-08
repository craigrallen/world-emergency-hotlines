import type { PayloadRequest } from 'payload';
import { headersWithCors } from 'payload';

export const ERRORS = Object.freeze({
  unauthenticated: [401, 'Sign in to continue'],
  forbidden: [403, 'Not allowed'],
  payload_too_large: [413, 'Request body too large'],
  invalid_request: [400, 'Request could not be processed'],
  unknown_offer: [400, 'Unknown offer'],
  unsupported_offer: [400, 'This offer cannot be purchased from the account page'],
  not_found: [404, 'Not found'],
  verification_failed: [400, 'This verification link is invalid or has already been used'],
  registration_closed: [403, 'Registration is closed'],
  email_unverified: [403, 'Verify your email address first'],
  stripe_disabled: [503, 'Billing is not enabled'],
  no_customer: [404, 'No billing customer is linked to this account'],
  no_entitlement: [403, 'An active subscription is required'],
  keys_unavailable: [503, 'API key issuance is not enabled'],
  key_limit: [409, 'Revoke an existing key before creating another'],
  plan_unconfigured: [409, 'This subscription has no API key policy configured'],
  signature_invalid: [400, 'Stripe signature could not be verified'],
  event_in_progress: [409, 'This event is still being processed; retry later'],
  handler_failed: [500, 'Event could not be applied; the delivery should be retried'],
  snapshot_too_large: [503, 'More active keys than one gateway snapshot can hold'],
  upstream_error: [502, 'Payment provider request failed'],
  unavailable: [503, 'Service unavailable'],
} as const);
export type ErrorCode = keyof typeof ERRORS;

export class EndpointError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { super(code); this.code = code; this.name = 'EndpointError'; }
}

function baseHeaders(req: PayloadRequest, extra: Record<string, string> = {}): Headers {
  return headersWithCors({
    req,
    headers: new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra }),
  });
}

export function json(req: PayloadRequest, status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: baseHeaders(req, extra) });
}

export function fail(req: PayloadRequest, code: ErrorCode, extra: Record<string, string> = {}): Response {
  const [status, message] = ERRORS[code];
  return json(req, status, { error: { code, message } }, extra);
}

/** Run an endpoint body, mapping EndpointError to the closed error envelope and anything else to 503. */
export async function guarded(req: PayloadRequest, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EndpointError) return fail(req, error.code);
    req.payload.logger.error({ err: error instanceof Error ? error.message : 'unknown', path: req.pathname }, 'cms endpoint failed');
    return fail(req, 'unavailable');
  }
}

/** Read a small JSON object body; anything else is invalid_request. */
export async function readJsonBody(req: PayloadRequest, maxBytes = 4096): Promise<Record<string, unknown>> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new EndpointError('invalid_request');
  const length = req.headers.get('content-length');
  if (length !== null && (!/^\d{1,7}$/.test(length) || Number(length) > maxBytes)) throw new EndpointError('invalid_request');
  let text: string;
  try { text = typeof req.text === 'function' ? await req.text() : ''; } catch { throw new EndpointError('invalid_request'); }
  if (text.length > maxBytes) throw new EndpointError('invalid_request');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new EndpointError('invalid_request'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new EndpointError('invalid_request');
  return parsed as Record<string, unknown>;
}
