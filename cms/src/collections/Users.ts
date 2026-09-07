import type { CollectionConfig } from 'payload';
import { addDataAndFileToRequest, headersWithCors, resetPasswordOperation, ValidationError } from 'payload';
import { generatePayloadCookie } from 'payload/shared';
import { ROLES, adminField, hasRole, isAdmin, isInternal, selfOrAdmin, selfOrStaff, staffField } from '../access';
import { getEnv } from '../env';
import { resetPasswordEmailHTML, resetPasswordEmailSubject, verifyEmailHTML, verifyEmailSubject } from '../lib/emails';

const env = getEnv();

/** Fields a signed-in member must never set on their own account. */
const PRIVILEGED_FIELDS = ['role', 'enableAPIKey', 'apiKey', 'apiKeyIndex', 'stripeCustomerId', 'notes', 'loginAttempts', 'lockUntil', '_verified', '_verificationToken', 'sessions'];
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export const Users: CollectionConfig = {
  slug: 'users',
  labels: { singular: 'User', plural: 'Users' },
  admin: {
    useAsTitle: 'email',
    defaultColumns: ['email', 'name', 'role', 'stripeCustomerId', 'updatedAt'],
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
      admin: { position: 'sidebar', description: 'admin: full control · staff: read-only admin access · member: account page · service: API-key-only automation (payments store, gateway key sync).' },
    },
    {
      name: 'stripeCustomerId',
      type: 'text',
      unique: true,
      index: true,
      access: { create: adminField, update: adminField },
      admin: { position: 'sidebar', readOnly: true, description: 'Pseudonymous Stripe customer id, linked by checkout or webhook. No card or address data is ever stored here.' },
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
    beforeValidate: [
      ({ data, req, operation, originalDoc }) => {
        if (!data) return data;
        const privileged = hasRole(req, 'admin') || isInternal(req);
        if (!privileged) {
          for (const field of PRIVILEGED_FIELDS) delete (data as Record<string, unknown>)[field];
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
        const result = await resetPasswordOperation({ collection, data: { password, token: typeof token === 'string' ? token : '' }, req });
        const headers = new Headers({ 'cache-control': 'no-store' });
        if (typeof result.token === 'string') headers.set('Set-Cookie', generatePayloadCookie({ collectionAuthConfig: collection.config.auth, cookiePrefix: req.payload.config.cookiePrefix, token: result.token }));
        return Response.json({ message: req.t('authentication:passwordResetSuccessfully'), ...result }, { headers: headersWithCors({ headers, req }), status: 200 });
      },
    },
  ],
  timestamps: true,
};
