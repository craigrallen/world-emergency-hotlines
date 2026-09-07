import type { CollectionConfig } from 'payload';
import { isAdmin, ownerOrStaff, staffField } from '../access';
import { GATEWAY_PERMISSIONS } from './Plans';

export const KEY_STATES = ['active', 'revoked', 'expired'] as const;

/**
 * Managed API gateway key records (gateway/contracts/v1/key-record.schema.json).
 * The raw key is shown to the member exactly once at creation and is never stored;
 * only the HMAC-SHA-256 verifier computed with GATEWAY_KEY_PEPPER is kept, and the
 * gateway pulls these records with `node src/cli.mjs sync-keys`.
 */
export const ApiKeys: CollectionConfig = {
  slug: 'api-keys',
  labels: { singular: 'API key', plural: 'API keys' },
  admin: {
    useAsTitle: 'keyId',
    defaultColumns: ['keyId', 'user', 'label', 'state', 'expiresAt', 'updatedAt'],
    group: 'Accounts',
    description: 'Managed API key records issued to subscribers. Raw keys are never stored; revoking here takes effect at the next gateway key sync.',
  },
  access: { read: ownerOrStaff('user'), create: isAdmin, update: isAdmin, delete: isAdmin },
  fields: [
    { name: 'keyId', type: 'text', required: true, unique: true, index: true, admin: { readOnly: true }, validate: (value: unknown) => (typeof value === 'string' && /^[a-z0-9]{12}$/.test(value) ? true : 'must be 12 lowercase alphanumerics') },
    { name: 'verifier', type: 'text', required: true, access: { read: staffField, update: () => false }, admin: { readOnly: true, description: 'base64url HMAC-SHA-256 of the raw key; never the key itself.' }, validate: (value: unknown) => (typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? true : 'must be a 43-character base64url verifier') },
    { name: 'user', type: 'relationship', relationTo: 'users', required: true, index: true },
    {
      name: 'issuedBy',
      type: 'select',
      required: true,
      defaultValue: 'admin',
      options: [{ label: 'Member account (granted by a subscription)', value: 'account' }, { label: 'Administrator', value: 'admin' }],
      admin: { readOnly: true, description: 'account: minted from /account and bound to the subscription below; if that subscription disappears the key leaves the gateway export. admin: created here without a granting subscription; follows the account\'s entitlement in its billing mode.' },
    },
    {
      name: 'subscription',
      type: 'relationship',
      relationTo: 'subscriptions',
      index: true,
      admin: { readOnly: true, description: 'Subscription that granted this key. The gateway export follows it: the key leaves the gateway export while that subscription is not active, and its permissions and quota follow the plan currently attached to it.' },
    },
    { name: 'label', type: 'text', maxLength: 60 },
    { name: 'state', type: 'select', required: true, defaultValue: 'active', options: KEY_STATES.map((value) => ({ label: value, value })) },
    { name: 'livemode', type: 'checkbox', required: true, defaultValue: false, admin: { readOnly: true, description: 'Billing mode of the subscription that entitled this key. Test-mode keys are exported to the gateway only while the CMS itself runs with a Stripe test key, so they stop working at live promotion.' } },
    { name: 'notBefore', type: 'date' },
    { name: 'expiresAt', type: 'date' },
    { name: 'revokedAt', type: 'date', admin: { readOnly: true } },
    { name: 'permissions', type: 'select', hasMany: true, required: true, defaultValue: [...GATEWAY_PERMISSIONS], options: GATEWAY_PERMISSIONS.map((value) => ({ label: value, value })) },
    { name: 'quotaRate', type: 'number', required: true, defaultValue: 1, min: 0.001, max: 1000 },
    { name: 'quotaBurst', type: 'number', required: true, defaultValue: 10, min: 1, max: 10000 },
  ],
  hooks: {
    beforeValidate: [
      ({ data, originalDoc }) => {
        if (!data) return data;
        if (data.state === 'revoked' && originalDoc?.state !== 'revoked') (data as Record<string, unknown>).revokedAt = new Date().toISOString();
        if (data.quotaBurst !== undefined && !Number.isInteger(data.quotaBurst)) throw new Error('quotaBurst must be an integer');
        const rate = (data.quotaRate as number | undefined) ?? (originalDoc?.quotaRate as number | undefined);
        const burst = (data.quotaBurst as number | undefined) ?? (originalDoc?.quotaBurst as number | undefined);
        if (rate !== undefined && burst !== undefined && burst > rate * 86400) throw new Error('quotaBurst must not exceed quotaRate × 86400');
        const notBefore = (data.notBefore as string | undefined) ?? (originalDoc?.notBefore as string | undefined);
        const expiresAt = (data.expiresAt as string | undefined) ?? (originalDoc?.expiresAt as string | undefined);
        if (notBefore && expiresAt && Date.parse(notBefore) >= Date.parse(expiresAt)) throw new Error('notBefore must be earlier than expiresAt');
        return data;
      },
    ],
  },
  timestamps: true,
};
