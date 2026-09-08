import type { CollectionConfig, PayloadRequest } from 'payload';
import { addDataAndFileToRequest, headersWithCors, resetPasswordOperation, ValidationError } from 'payload';
import { generatePayloadCookie } from 'payload/shared';
import { sql } from '@payloadcms/db-postgres';
import { INTERNAL_CONTEXT, ROLES, SERVICE_SCOPES, adminField, hasRole, isAdmin, isInternal, selfOrAdmin, selfOrStaff, staffField } from '../access';
import { getEnv } from '../env';
import { resetPasswordEmailHTML, resetPasswordEmailSubject, verifyEmailHTML, verifyEmailSubject } from '../lib/emails';

const env = getEnv();

/** Fields a signed-in member must never set on their own account. */
const PRIVILEGED_FIELDS = ['role', 'serviceScope', 'enableAPIKey', 'apiKey', 'apiKeyIndex', 'stripeLiveCustomerId', 'stripeTestCustomerId', 'notes', 'loginAttempts', 'lockUntil', '_verified', '_verificationToken', 'sessions'];
// Only Payload’s server-side operation hook can mark a trusted reset request.
const trustedResets = new WeakSet<object>();
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

async function lockAdministrators(req: PayloadRequest): Promise<void> {
  const adapter = req.payload.db as unknown as { name?: string; sessions?: Record<string, { db: { execute(query: unknown): Promise<unknown> } }>; tableNameMap?: Map<string, string> };
  if (adapter.name !== 'postgres') return;
  if (!req.transactionID) throw new Error('Postgres transaction is required while protecting administrators');
  const session = adapter.sessions?.[String(req.transactionID)]?.db;
  if (!session) throw new Error('Postgres transaction session is unavailable while protecting administrators');
  const table = adapter.tableNameMap?.get('users') ?? 'users';
  // Every admin-removal path takes the complete current admin set in a stable order.
  // Concurrent demotions/deletes therefore re-check after the first transaction commits.
  await session.execute(sql`SELECT id FROM ${sql.identifier(table)} WHERE role = 'admin' ORDER BY id FOR UPDATE`);
}

async function refuseLastAdmin(req: PayloadRequest, id: string | number): Promise<void> {
  await lockAdministrators(req);
  const user = await req.payload.findByID({ collection: 'users', id, depth: 0, overrideAccess: true, req });
  if (user.role !== 'admin') return;
  const others = await req.payload.count({ collection: 'users', where: { and: [{ role: { equals: 'admin' } }, { id: { not_equals: id } }] }, overrideAccess: true, req });
  if (others.totalDocs === 0) throw new ValidationError({ collection: 'users', errors: [{ path: 'role', message: 'The last administrator cannot be removed' }] }, req.t);
}

export const Users: CollectionConfig = {
  slug: 'users',
  labels: { singular: 'User', plural: 'Users' },
  admin: {
    useAsTitle: 'email',
    defaultColumns: ['email', 'name', 'role', 'stripeLiveCustomerId', 'updatedAt'],
    group: 'Accounts',
    description: 'Account holders, staff, and service accounts. Members register through the public account page; only admins change roles or enable API keys.',
  },
  auth: {
    useAPIKey: true,
    maxLoginAttempts: 5,
    lockTime: 10 * 60 * 1000,
    tokenExpiration: 2 * 60 * 60,
    cookies: { sameSite: 'Lax', secure: env.cookieSecure },
    // Verification fields are part of the schema in every mode so the committed
    // Postgres migration supports CMS_REQUIRE_EMAIL_VERIFICATION either way; when
    // verification is not required, new accounts are created already verified.
    verify: { generateEmailHTML: verifyEmailHTML, generateEmailSubject: verifyEmailSubject },
    forgotPassword: { generateEmailHTML: resetPasswordEmailHTML, generateEmailSubject: resetPasswordEmailSubject },
  },
  access: {
    admin: ({ req }) => hasRole(req, 'admin', 'staff'),
    create: ({ req }) => hasRole(req, 'admin') || isInternal(req) || env.registration === 'open',
    read: selfOrStaff,
    update: selfOrAdmin,
    delete: isAdmin,
    unlock: isAdmin,
  },
  fields: [
    { name: 'name', type: 'text', maxLength: 120, admin: { description: 'Optional display name.' } },
    {
      name: 'role',
      type: 'select',
      options: ROLES.map((role) => ({ label: role, value: role })),
      defaultValue: 'member',
      required: true,
      saveToJWT: true,
      access: { create: adminField, update: adminField },
      admin: { position: 'sidebar', description: 'admin: full control · staff: read-only admin access · member: account page · service: API-key-only automation limited to one scope (see Service scope).' },
    },
    {
      name: 'serviceScope',
      type: 'select',
      options: SERVICE_SCOPES.map((scope) => ({ label: scope, value: scope })),
      access: { create: adminField, update: adminField },
      admin: {
        position: 'sidebar',
        condition: (data) => data?.role === 'service',
        description: 'Required for service accounts; each automation gets its own account and key. payments_store: webhook ledger and entitlement records for the payments service. gateway_sync: key-record export for the gateway. A scope grants nothing else.',
      },
    },
    // Stripe keeps test and live objects in separate namespaces: one customer per billing mode, so a deployment promoted from
    // test to live creates live customers instead of reusing test ids the live client would refuse (see lib/customers.ts).
    {
      name: 'stripeLiveCustomerId',
      type: 'text',
      unique: true,
      index: true,
      access: { create: adminField, update: adminField },
      admin: { position: 'sidebar', readOnly: true, description: 'Pseudonymous live-mode Stripe customer id, linked by checkout or webhook while the CMS runs with a live key. No card or address data is ever stored here.' },
      validate: (value: unknown) => (value === undefined || value === null || value === '' || (typeof value === 'string' && /^cus_[A-Za-z0-9]{8,}$/.test(value)) ? true : 'must be a Stripe customer id (cus_…)'),
    },
    {
      name: 'stripeTestCustomerId',
      type: 'text',
      unique: true,
      index: true,
      access: { create: adminField, update: adminField },
      admin: { position: 'sidebar', readOnly: true, description: 'Pseudonymous test-mode Stripe customer id, linked by checkout or webhook while the CMS runs with a test key.' },
      validate: (value: unknown) => (value === undefined || value === null || value === '' || (typeof value === 'string' && /^cus_[A-Za-z0-9]{8,}$/.test(value)) ? true : 'must be a Stripe customer id (cus_…)'),
    },
    {
      name: 'notes',
      type: 'textarea',
      maxLength: 2000,
      access: { read: staffField, create: staffField, update: staffField },
      admin: { description: 'Internal staff notes. Never returned to the member.' },
    },
  ],
  hooks: {
    beforeOperation: [
      // Verification fields are always in the schema; when verification is not
      // required, accounts are created already verified and must not be emailed a
      // verification link they cannot use.
      ({ args, operation, req }) => {
        if (operation === 'resetPassword') trustedResets.add(req);
        if (operation === 'create' && !env.requireEmailVerification) (args as { disableVerificationEmail?: boolean }).disableVerificationEmail = true;
        return args;
      },
    ],
    beforeDelete: [
      // Managed keys belong to the account: deleting the account deletes them in the
      // same transaction (the gateway drops them at its next sync). Without this the
      // required `api-keys.user` relation makes Postgres refuse the delete.
      async ({ id, req }) => {
        await refuseLastAdmin(req, id);
        await req.payload.delete({ collection: 'api-keys', where: { user: { equals: id } }, depth: 0, overrideAccess: true, context: { ...INTERNAL_CONTEXT }, req });
      },
    ],
    beforeValidate: [
      async ({ data, req, operation, originalDoc }) => {
        if (!data) return data;
        // Reset validation receives a database-loaded user, never the client body, and no originalDoc.
        if (trustedResets.delete(req)) return data;
        const privileged = hasRole(req, 'admin') || isInternal(req);
        if (operation === 'update' && originalDoc?.role === 'admin' && data.role !== undefined && data.role !== 'admin') {
          await lockAdministrators(req);
          const others = await req.payload.count({ collection: 'users', where: { and: [{ role: { equals: 'admin' } }, { id: { not_equals: originalDoc.id } }] }, overrideAccess: true, req });
          if (others.totalDocs === 0) throw new ValidationError({ collection: 'users', errors: [{ path: 'role', message: 'The last administrator cannot be demoted' }] }, req.t);
        }
        if (!privileged && operation === 'update' && data.email !== undefined && data.email !== originalDoc?.email) {
          throw new ValidationError({ collection: 'users', errors: [{ path: 'email', message: 'Email changes require a re-verification flow and are disabled' }] }, req.t);
        }
        if (!privileged) {
          for (const field of PRIVILEGED_FIELDS) {
            delete (data as Record<string, unknown>)[field];
            if (operation === 'update' && originalDoc && field in originalDoc) (data as Record<string, unknown>)[field] = originalDoc[field];
          }
          // `role` is required, so pin it explicitly instead of leaving it undefined.
          (data as Record<string, unknown>).role = operation === 'create' ? 'member' : ((originalDoc?.role as string | undefined) ?? 'member');
        }
        // Server-side password policy for registration, self-service change, and reset alike.
        if (data.password !== undefined && data.password !== null) {
          if (typeof data.password !== 'string' || data.password.length < PASSWORD_MIN_LENGTH || data.password.length > PASSWORD_MAX_LENGTH) {
            throw new ValidationError({ collection: 'users', errors: [{ path: 'password', message: `Password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters` }] }, req.t);
          }
        }
        if (operation === 'create' && !env.requireEmailVerification && (data as Record<string, unknown>)._verified === undefined) {
          (data as Record<string, unknown>)._verified = true;
        }
        // API keys belong to service accounts (and admins). Any other role loses them.
        const role = (data.role as string | undefined) ?? (originalDoc?.role as string | undefined) ?? 'member';
        // A service account is exactly one automation: it must name its scope, and no other role carries one.
        if (role === 'service') {
          const scope = (data as Record<string, unknown>).serviceScope ?? originalDoc?.serviceScope;
          if (!(SERVICE_SCOPES as readonly string[]).includes(String(scope))) {
            throw new ValidationError({ collection: 'users', errors: [{ path: 'serviceScope', message: `Service accounts need a scope: ${SERVICE_SCOPES.join(' or ')}` }] }, req.t);
          }
        } else if (operation === 'create' || data.role !== undefined || (data as Record<string, unknown>).serviceScope !== undefined) {
          (data as Record<string, unknown>).serviceScope = null;
        }
        if (role !== 'service' && role !== 'admin') {
          if (operation === 'create' || data.enableAPIKey !== undefined || data.apiKey !== undefined || data.role !== undefined) {
            (data as Record<string, unknown>).enableAPIKey = false;
            (data as Record<string, unknown>).apiKey = null;
          }
        }
        return data;
      },
    ],
  },
  endpoints: [
    { path: '/first-register', method: 'post', handler: () => Response.json({ errors: [{ message: 'First-user setup is disabled. Configure CMS_ADMIN_EMAIL and CMS_ADMIN_PASSWORD before startup.' }] }, { status: 403 }) },
    {
      // Overrides Payload's built-in reset so the password policy also covers the
      // reset path: the built-in operation hashes the new password without running
      // the collection's beforeValidate hook against it.
      path: '/reset-password',
      method: 'post',
      handler: async (req) => {
        await addDataAndFileToRequest(req);
        const password = req.data?.password;
        const token = req.data?.token;
        if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
          throw new ValidationError({ collection: 'users', errors: [{ path: 'password', message: `Password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters` }] }, req.t);
        }
        const collection = req.payload.collections.users;
        let result;
        try {
          result = await resetPasswordOperation({ collection, data: { password, token: typeof token === 'string' ? token : '' }, req });
        } finally {
          trustedResets.delete(req);
        }
        const headers = new Headers({ 'cache-control': 'no-store' });
        if (typeof result.token === 'string') headers.set('Set-Cookie', generatePayloadCookie({ collectionAuthConfig: collection.config.auth, cookiePrefix: req.payload.config.cookiePrefix, token: result.token }));
        return Response.json({ message: req.t('authentication:passwordResetSuccessfully'), ...result }, { headers: headersWithCors({ headers, req }), status: 200 });
      },
    },
  ],
  timestamps: true,
};
