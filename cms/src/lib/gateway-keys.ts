// Mirrors gateway/src/security.mjs so keys issued here authenticate at the gateway.
import { createHmac, randomBytes } from 'node:crypto';

export const KEY_PATTERN = /^weh_live_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

export function verifierFor(raw: string, pepper: string): string {
  return createHmac('sha256', pepper).update(raw).digest('base64url');
}

export function createGatewayKey(pepper: string): { id: string; raw: string; verifier: string } {
  const id = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const raw = `weh_live_${id}_${secret}`;
  if (!KEY_PATTERN.test(raw)) throw new Error('generated key did not match the gateway key pattern');
  return { id, raw, verifier: verifierFor(raw, pepper) };
}

export interface GatewayKeyRecord {
  id: string;
  verifier: string;
  state: 'active' | 'revoked' | 'expired';
  not_before: string | null;
  expires_at: string | null;
  api_majors: [1];
  permissions: string[];
  quota: { rate: number; burst: number };
  synthetic: false;
}

const canonicalDate = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

/** Project an api-keys document into the exact gateway key-record contract. */
export function toGatewayRecord(doc: Record<string, unknown>): GatewayKeyRecord {
  const now = Date.now();
  const expiresAt = canonicalDate(doc.expiresAt);
  let state: GatewayKeyRecord['state'] = doc.state === 'revoked' || doc.state === 'expired' ? doc.state : 'active';
  if (state === 'active' && expiresAt !== null && Date.parse(expiresAt) <= now) state = 'expired';
  return {
    id: String(doc.keyId),
    verifier: String(doc.verifier),
    state,
    not_before: canonicalDate(doc.notBefore),
    expires_at: expiresAt,
    api_majors: [1],
    permissions: Array.isArray(doc.permissions) ? [...new Set(doc.permissions.map(String))] : ['manifest', 'records', 'resolver'],
    quota: { rate: Number(doc.quotaRate), burst: Number(doc.quotaBurst) },
    synthetic: false,
  };
}
