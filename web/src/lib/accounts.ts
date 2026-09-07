// Build-time view of the account/CMS foundation for the /account pages.
//
// PUBLIC_ACCOUNTS_MODE only decides the initial render: the pages always probe
// /cms/api/account/status at runtime and Caddy answers 503 accounts_disabled
// until CMS_UPSTREAM is configured, so a stale build value can never sign anyone
// in or start a checkout on its own.
export const ACCOUNTS_MODES = ['disabled', 'enabled'] as const;
export type AccountsMode = (typeof ACCOUNTS_MODES)[number];

const rawMode = import.meta.env.PUBLIC_ACCOUNTS_MODE;
export const ACCOUNTS_MODE: AccountsMode = rawMode === 'enabled' ? 'enabled' : 'disabled';
export const ACCOUNTS_ENABLED = ACCOUNTS_MODE === 'enabled';

/** Payload REST base (routes.api in cms/src/payload.config.ts); proxied by Caddy same-origin. */
export const CMS_API = '/cms/api';
export const ACCOUNT_ENDPOINTS = Object.freeze({
  status: `${CMS_API}/account/status`,
  me: `${CMS_API}/account/me`,
  checkout: `${CMS_API}/account/checkout`,
  portal: `${CMS_API}/account/portal`,
  apiKeys: `${CMS_API}/account/api-keys`,
  login: `${CMS_API}/users/login`,
  logout: `${CMS_API}/users/logout`,
  register: `${CMS_API}/users`,
  forgotPassword: `${CMS_API}/users/forgot-password`,
  resetPassword: `${CMS_API}/users/reset-password`,
  verify: `${CMS_API}/users/verify`,
});
export const ADMIN_PATH = '/admin';
export const RUNBOOK_URL = 'https://github.com/craigrallen/world-emergency-hotlines/blob/main/docs/ACCOUNTS.md';
