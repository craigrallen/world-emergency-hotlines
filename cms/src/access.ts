import type { Access, FieldAccess, PayloadRequest, Where } from 'payload';

export const ROLES = ['admin', 'staff', 'member', 'service'] as const;
export type Role = (typeof ROLES)[number];
/**
 * What a service account's API key may do. Each automation gets its own key with
 * exactly one scope, so the gateway-sync credential cannot write entitlements and
 * the payments-store credential cannot export key records.
 */
export const SERVICE_SCOPES = ['payments_store', 'gateway_sync'] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];

export interface RequestUser {
  id: string | number;
  email?: string;
  name?: string | null;
  role?: Role | string;
  serviceScope?: ServiceScope | string | null;
  stripeLiveCustomerId?: string | null;
  stripeTestCustomerId?: string | null;
  _strategy?: string;
  collection?: string;
  _verified?: boolean | null;
  [key: string]: unknown;
}

/** The authenticated `users` document, or null for anonymous requests. */
export function userOf(req: PayloadRequest): RequestUser | null {
  const user = req.user as unknown as RequestUser | null;
  if (!user || (user.collection !== undefined && user.collection !== 'users')) return null;
  return user;
}

export function hasRole(req: PayloadRequest, ...roles: Role[]): boolean {
  const user = userOf(req);
  return user !== null && typeof user.role === 'string' && (roles as string[]).includes(user.role);
}

/** Service accounts authenticate only with their API key, never with a browser session, and only within their scope. */
export function isServiceRequest(req: PayloadRequest, scope?: ServiceScope): boolean {
  const user = userOf(req);
  if (user === null || user.role !== 'service' || user._strategy !== 'api-key') return false;
  return scope === undefined ? true : user.serviceScope === scope;
}

/** A person with an account page: member, staff, or admin signed in through a session. */
export function accountUser(req: PayloadRequest): RequestUser | null {
  const user = userOf(req);
  if (!user || user.role === 'service' || user._strategy === 'api-key') return null;
  return user;
}

export const isAdmin: Access = ({ req }) => hasRole(req, 'admin');
export const isStaff: Access = ({ req }) => hasRole(req, 'admin', 'staff');
/** The payments service's store credential: webhook ledger and entitlement records, nothing else. */
export const isAdminOrPaymentsStore: Access = ({ req }) => hasRole(req, 'admin') || isServiceRequest(req, 'payments_store');
export const isStaffOrPaymentsStore: Access = ({ req }) => hasRole(req, 'admin', 'staff') || isServiceRequest(req, 'payments_store');
export const denyAll: Access = () => false;

/** Staff read everything; everyone else reads only documents whose `field` points at them. Service keys read nothing here. */
export const ownerOrStaff = (field = 'user'): Access => ({ req }) => {
  if (hasRole(req, 'admin', 'staff')) return true;
  const user = accountUser(req);
  if (!user) return false;
  return { [field]: { equals: user.id } } as Where;
};

export const selfOrStaff: Access = ({ req }) => {
  if (hasRole(req, 'admin', 'staff')) return true;
  const user = accountUser(req);
  return user ? ({ id: { equals: user.id } } as Where) : false;
};

export const selfOrAdmin: Access = ({ req }) => {
  if (hasRole(req, 'admin')) return true;
  const user = accountUser(req);
  return user ? ({ id: { equals: user.id } } as Where) : false;
};

export const adminField: FieldAccess = ({ req }) => hasRole(req, 'admin');
export const staffField: FieldAccess = ({ req }) => hasRole(req, 'admin', 'staff');

/** Local API calls made by the CMS itself mark their request context so hooks can trust them. */
export const INTERNAL_CONTEXT = Object.freeze({ cmsInternal: true });
export function isInternal(req: PayloadRequest): boolean {
  return req.context?.cmsInternal === true;
}
