// Durable store backed by the Payload CMS (`cms/`) REST API.
//
// Implements the four-method store contract from store.mjs on top of two CMS
// collections: `stripe-events` (webhook idempotency ledger; one claim per consumer
// and event, unique `claimKey` = source:eventId) and `entitlements` (unique key,
// pseudonymous Stripe ids and enum statuses only). The CMS enforces
// first-writer-wins through its unique indexes, so claimEvent is atomic across
// payments replicas, and it refuses (409) an entitlement write that would move any
// event family's epoch backwards, which surfaces here as a conflict (STORE_CONFLICT)
// that events.mjs resolves by re-reading. Every other failure throws CmsStoreError;
// the server maps store errors to 503 unavailable / 500 handler_failed so Stripe
// retries. The API key never appears in error messages or logs.

import { STORE_CONFLICT } from './store.mjs';
import { plain } from './validation.mjs';

export const CMS_STORE_KIND = 'cms';
export const EVENTS_COLLECTION = 'stripe-events';
export const ENTITLEMENTS_COLLECTION = 'entitlements';
export const CMS_API_KEY = /^[A-Za-z0-9_-]{16,256}$/;
export const DEFAULT_CMS_TIMEOUT_MS = 10000;
const EVENT_ID = /^evt_[A-Za-z0-9]{8,}$/;
const ENTITLEMENT_KEY = /^(cs|sub):[a-z]{2,10}_(?:(?:test|live)_)?[A-Za-z0-9]{8,}$/;
const CMS_SOURCE = 'payments';
/** This consumer's claim on an event; the CMS derives the same value server-side. */
export const claimKeyFor = (eventId) => `${CMS_SOURCE}:${eventId}`;

export class CmsStoreError extends Error {
  constructor(reason, status = null) {
    super(`cms store ${reason}${status === null ? '' : ` (status ${status})`}`);
    this.name = 'CmsStoreError';
    this.reason = reason;
    this.status = status;
    if (reason === 'conflict') this.code = STORE_CONFLICT;
  }
}

/**
 * The CMS base API URL: http(s), no credentials, query, fragment, or trailing
 * slash. Plain http is accepted only for loopback and private-network hosts
 * (`localhost`, `*.internal`, `*.local`), which is where Railway/Compose place
 * the CMS; anything reachable from the public internet must be https.
 */
export function validCmsUrl(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 512 || value.endsWith('/') || /\s/.test(value)) return false;
  // Dot segments are refused on the raw string because URL parsing would normalise them away.
  if (value.replace(/^[a-z]+:\/\/[^/]*/i, '').split('/').some((segment) => segment === '.' || segment === '..')) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.search || url.hash) return false;
  if (!/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/.test(url.pathname)) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.localhost');
}

/** Map an entitlement record onto the CMS document shape (structured columns + the full record). */
export function toEntitlementDocument(record) {
  const text = (value) => (typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null);
  return {
    key: record.key,
    kind: record.kind === 'checkout_session' || record.kind === 'subscription' ? record.kind : 'unknown',
    offer: text(record.offer),
    offerKnown: record.offer_known === true,
    status: text(record.status) ?? 'unknown',
    customer: text(record.customer),
    subscription: text(record.subscription) ?? (record.kind === 'subscription' ? record.key.slice(4) : null),
    checkoutSession: text(record.checkout_session) ?? (record.kind === 'checkout_session' ? record.key.slice(3) : null),
    paymentIntent: text(record.payment_intent),
    livemode: record.livemode === true,
    updatedAtEpoch: Number.isInteger(record.updated_at_epoch) ? record.updated_at_epoch : null,
    sourceEvent: text(record.source_event),
    source: CMS_SOURCE,
    record,
  };
}

export function createCmsStore({ url, apiKey, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_CMS_TIMEOUT_MS, usersCollection = 'users' } = {}) {
  if (!validCmsUrl(url)) throw new Error('cms store requires a valid CMS API URL');
  if (typeof apiKey !== 'string' || !CMS_API_KEY.test(apiKey)) throw new Error('cms store requires an API key');
  if (typeof fetchImpl !== 'function') throw new Error('cms store requires fetch');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('cms store timeout out of range');
  if (typeof usersCollection !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(usersCollection)) throw new Error('cms store users collection slug invalid');
  const authorization = `${usersCollection} API-Key ${apiKey}`;

  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${url}${path}`, {
        method,
        headers: { authorization, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      throw new CmsStoreError(controller.signal.aborted ? 'timeout' : 'network_error');
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (response.status === 401 || response.status === 403) throw new CmsStoreError('unauthorized', response.status);
    return { status: response.status, payload: plain(payload) ? payload : null };
  }

  const where = (field, value) => `?where[${field}][equals]=${encodeURIComponent(value)}&limit=1&depth=0`;

  async function findOne(collection, field, value) {
    const { status, payload } = await request('GET', `/${collection}${where(field, value)}`);
    if (status !== 200 || !payload || !Array.isArray(payload.docs)) throw new CmsStoreError('lookup_failed', status);
    const doc = payload.docs[0];
    return plain(doc) ? doc : null;
  }

  return Object.freeze({
    kind: CMS_STORE_KIND,
    async claimEvent(id) {
      if (typeof id !== 'string' || !EVENT_ID.test(id)) throw new TypeError('event id required');
      const { status, payload } = await request('POST', `/${EVENTS_COLLECTION}`, { eventId: id, source: CMS_SOURCE });
      if (status === 201 || status === 200) {
        if (!payload || !plain(payload.doc)) throw new CmsStoreError('claim_unconfirmed', status);
        return true;
      }
      if (status === 400) {
        // The unique index refused the insert; confirm this consumer's claim is really
        // recorded before reporting a duplicate so a schema error cannot silently drop events.
        const existing = await findOne(EVENTS_COLLECTION, 'claimKey', claimKeyFor(id));
        if (existing) return false;
        throw new CmsStoreError('claim_rejected', status);
      }
      throw new CmsStoreError('claim_failed', status);
    },
    async releaseEvent(id) {
      if (typeof id !== 'string' || !EVENT_ID.test(id)) throw new TypeError('event id required');
      const { status } = await request('DELETE', `/${EVENTS_COLLECTION}?where[claimKey][equals]=${encodeURIComponent(claimKeyFor(id))}`);
      if (status !== 200) throw new CmsStoreError('release_failed', status);
    },
    async getEntitlement(key) {
      if (typeof key !== 'string' || !ENTITLEMENT_KEY.test(key)) throw new TypeError('entitlement key required');
      const doc = await findOne(ENTITLEMENTS_COLLECTION, 'key', key);
      if (!doc) return null;
      if (!plain(doc.record) || doc.record.key !== key) throw new CmsStoreError('record_shape_invalid');
      return Object.freeze({ ...doc.record });
    },
    async putEntitlement(record) {
      if (!plain(record) || typeof record.key !== 'string' || !ENTITLEMENT_KEY.test(record.key)) throw new TypeError('entitlement record requires a key');
      const frozen = Object.freeze({ ...record });
      const document = toEntitlementDocument(frozen);
      // The CMS compares the incoming record's per-family epochs with the stored ones
      // under a row lock and answers 409 when this write would move one backwards.
      const update = async (id) => {
        const { status } = await request('PATCH', `/${ENTITLEMENTS_COLLECTION}/${encodeURIComponent(String(id))}?depth=0`, document);
        if (status === 409) throw new CmsStoreError('conflict', status);
        if (status !== 200) throw new CmsStoreError('update_failed', status);
        return frozen;
      };
      const existing = await findOne(ENTITLEMENTS_COLLECTION, 'key', frozen.key);
      if (existing && (typeof existing.id === 'string' || typeof existing.id === 'number')) return update(existing.id);
      const created = await request('POST', `/${ENTITLEMENTS_COLLECTION}?depth=0`, document);
      if (created.status === 201 || created.status === 200) return frozen;
      if (created.status === 400) {
        // Lost a create race with another replica: the unique key now exists, so update
        // it (the 409 guard above still applies if the winner carried newer events).
        const raced = await findOne(ENTITLEMENTS_COLLECTION, 'key', frozen.key);
        if (!raced || (typeof raced.id !== 'string' && typeof raced.id !== 'number')) throw new CmsStoreError('create_rejected', created.status);
        return update(raced.id);
      }
      throw new CmsStoreError('create_failed', created.status);
    },
  });
}
