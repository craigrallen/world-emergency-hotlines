// Client-side controller for the /account pages. Talks only to the same-origin
// Payload CMS REST API (proxied at /cms/api); cookies stay HTTP-only. Every
// request degrades to the "not enabled" state when Caddy answers 503.
const API = '/cms/api';
const ENDPOINTS = {
  status: `${API}/account/status`, me: `${API}/account/me`, checkout: `${API}/account/checkout`, portal: `${API}/account/portal`, apiKeys: `${API}/account/api-keys`,
  login: `${API}/users/login`, logout: `${API}/users/logout`, register: `${API}/users`, forgot: `${API}/users/forgot-password`, reset: `${API}/users/reset-password`, verify: `${API}/users/verify`,
};
const STRIPE_HOSTED = ['https://checkout.stripe.com/', 'https://billing.stripe.com/'];

export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { ok: response.ok, status: response.status, data };
}

/** Human-readable message from a Payload or account-endpoint error envelope. */
export function errorMessage(result, fallback = 'Something went wrong. Please try again.') {
  const data = result?.data;
  if (data?.error?.code === 'accounts_disabled') return 'Accounts are not enabled on this site yet.';
  if (typeof data?.error?.message === 'string') return data.error.message;
  const first = Array.isArray(data?.errors) ? data.errors[0] : null;
  const fieldErrors = first?.data?.errors;
  if (Array.isArray(fieldErrors) && fieldErrors.length) return fieldErrors.map((item) => `${item.path ?? item.field ?? 'field'}: ${item.message}`).join('; ');
  if (typeof first?.message === 'string') return first.message;
  if (result?.status === 401) return 'Email or password did not match, or the account is locked for a few minutes after too many attempts.';
  if (result?.status === 503) return 'The account service is unavailable right now.';
  return fallback;
}

export async function fetchStatus() {
  try {
    const result = await api(ENDPOINTS.status);
    if (result.ok && result.data?.component === 'cms' && result.data.status === 'enabled') return { enabled: true, ...result.data };
  } catch { /* network failure is the disabled state */ }
  return { enabled: false };
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const text = (value) => document.createTextNode(String(value ?? ''));
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) node.append(child instanceof Node ? child : text(child));
  return node;
}

function setView(root, view) {
  root.dataset.accountView = view;
  for (const section of root.querySelectorAll('[data-account-view]')) section.hidden = section.dataset.accountView !== view;
}
function setEnabled(root, enabled) {
  root.dataset.accountsMode = enabled ? 'enabled' : 'disabled';
  for (const control of root.querySelectorAll('button, input, select, textarea')) control.disabled = !enabled;
}
function flash(root, message, tone = 'info') {
  const node = root.querySelector('[data-account-flash]');
  if (!node) return;
  node.textContent = message ?? '';
  node.hidden = !message;
  node.dataset.tone = tone;
}
function consumeQueryFlash(root) {
  try {
    const url = new URL(window.location.href);
    const checkout = url.searchParams.get('checkout');
    if (checkout === 'success') flash(root, 'Checkout complete. Your subscription appears below once Stripe confirms it by webhook (usually within a minute); refresh if it is not there yet.', 'success');
    if (checkout === 'cancelled') flash(root, 'Checkout cancelled. Nothing was charged.', 'info');
    if (url.searchParams.get('verified') === '1') flash(root, 'Email verified. You can sign in now.', 'success');
    if (url.searchParams.get('reset') === '1') flash(root, 'Password updated. You are signed in.', 'success');
    for (const key of ['checkout', 'verified', 'reset', 'session_id']) url.searchParams.delete(key);
    history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
  } catch { /* ignore malformed URLs */ }
}

function redirectToStripe(url) {
  if (typeof url === 'string' && STRIPE_HOSTED.some((origin) => url.startsWith(origin))) { window.location.assign(url); return true; }
  return false;
}

function renderSignedIn(root, status, me) {
  const profile = root.querySelector('[data-account-profile]');
  profile.replaceChildren(
    el('dl', { class: 'grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6' }, [
      el('dt', { class: 'text-fg-muted' }, 'Email'), el('dd', { class: 'text-fg' }, me.user.email),
      el('dt', { class: 'text-fg-muted' }, 'Name'), el('dd', { class: 'text-fg' }, me.user.name || '—'),
      el('dt', { class: 'text-fg-muted' }, 'Role'), el('dd', { class: 'text-fg' }, me.user.role),
      el('dt', { class: 'text-fg-muted' }, 'Billing customer'), el('dd', { class: 'text-fg' }, me.user.billing_customer_linked ? 'Linked to Stripe' : 'Not linked yet'),
    ]),
  );
  const staffSlot = root.querySelector('[data-account-staff]');
  staffSlot.replaceChildren();
  if (me.user.role === 'admin' || me.user.role === 'staff') {
    staffSlot.append(el('a', { class: 'btn-ghost', href: '/admin' }, 'Open the admin panel'));
  }
  root.querySelector('[data-account-name-input]').value = me.user.name || '';

  const entitlement = root.querySelector('[data-account-entitlement]');
  entitlement.textContent = me.entitlement.active ? `Active subscription: ${me.entitlement.offer ?? 'plan'}.` : 'No active subscription.';

  const subs = root.querySelector('[data-account-subscriptions]');
  subs.replaceChildren();
  if (!me.subscriptions.length) subs.append(el('p', { class: 'text-sm text-fg-muted' }, 'No subscriptions are recorded for this account.'));
  for (const sub of me.subscriptions) {
    subs.append(el('li', { class: 'rounded-xl border border-border bg-bg p-4 text-sm' }, [
      el('p', { class: 'font-semibold text-fg' }, `${sub.offer ?? 'Subscription'} · ${sub.status}${sub.livemode ? '' : ' · test mode'}`),
      el('p', { class: 'mt-1 text-fg-muted' }, `Renews or ends ${formatDate(sub.current_period_end)}${sub.cancel_at_period_end ? ' (cancels at period end)' : ''}${sub.last_invoice_status ? ` · last invoice ${sub.last_invoice_status}` : ''}`),
      el('p', { class: 'mt-1 break-all text-xs text-fg-muted' }, `Reference ${sub.id}`),
    ]));
  }

  const plans = root.querySelector('[data-account-plans]');
  plans.replaceChildren();
  const checkoutOn = status.stripe?.checkout === true && Array.isArray(status.offers) && status.offers.length > 0;
  root.querySelector('[data-account-billing-disabled]').hidden = checkoutOn;
  if (status.stripe?.mode === 'test') root.querySelector('[data-account-test-mode]').hidden = false;
  for (const offer of checkoutOn ? status.offers : []) {
    const button = el('button', { type: 'button', class: 'btn-primary mt-4' }, offer.mode === 'subscription' ? 'Subscribe via secure checkout' : 'Pay via secure checkout');
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await api(ENDPOINTS.checkout, { method: 'POST', body: { offer: offer.id } });
      if (!(result.ok && redirectToStripe(result.data?.url))) { flash(root, errorMessage(result), 'error'); button.disabled = false; }
    });
    plans.append(el('div', { class: 'card p-5', dataset: { offer: offer.id } }, [
      el('p', { class: 'text-xs font-semibold uppercase tracking-wider text-accent' }, offer.mode === 'subscription' ? 'Subscription' : 'One-time payment'),
      el('h4', { class: 'mt-1 text-lg font-semibold text-fg' }, offer.label),
      el('p', { class: 'mt-2 text-sm text-fg-muted' }, offer.description || ''),
      el('p', { class: 'mt-2 text-sm text-fg-muted' }, 'Price: shown on Stripe’s checkout page, not published here.'),
      button,
    ]));
  }
  const portal = root.querySelector('[data-account-portal]');
  portal.disabled = !(status.stripe?.mode && status.stripe.mode !== 'disabled' && me.user.billing_customer_linked);

  const keys = root.querySelector('[data-account-keys]');
  keys.replaceChildren();
  if (!me.api_keys.length) keys.append(el('p', { class: 'text-sm text-fg-muted' }, 'No managed API keys have been issued to this account.'));
  for (const key of me.api_keys) {
    const revoke = el('button', { type: 'button', class: 'btn-ghost text-xs', disabled: key.state !== 'active' }, key.state === 'active' ? 'Revoke' : key.state);
    revoke.addEventListener('click', async () => {
      if (!window.confirm(`Revoke key ${key.id}? Integrations using it stop working at the next gateway key sync.`)) return;
      revoke.disabled = true;
      const result = await api(`${ENDPOINTS.apiKeys}/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
      if (result.ok) await refresh(root, status); else { flash(root, errorMessage(result), 'error'); revoke.disabled = false; }
    });
    keys.append(el('li', { class: 'flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg p-4 text-sm' }, [
      el('div', {}, [
        el('p', { class: 'font-semibold text-fg' }, `${key.label || 'Managed API key'} · weh_live_${key.id}_…`),
        el('p', { class: 'mt-1 text-xs text-fg-muted' }, `${key.state} · created ${formatDate(key.created_at)} · ${Array.isArray(key.permissions) ? key.permissions.join(', ') : ''} · ${key.quota?.rate}/s, burst ${key.quota?.burst}`),
      ]),
      revoke,
    ]));
  }
  const keyForm = root.querySelector('[data-account-key-form]');
  const keysOn = status.gateway?.key_issuance === true && me.entitlement.active;
  keyForm.querySelector('button').disabled = !keysOn;
  root.querySelector('[data-account-keys-note]').textContent = status.gateway?.key_issuance !== true
    ? 'Managed API key issuance is not enabled on this deployment.'
    : me.entitlement.active ? `Up to ${me.gateway?.max_keys ?? 5} active keys. Keys authenticate against the managed API gateway only; every free static surface stays keyless.` : 'An active subscription is required before a key can be issued.';
}

async function refresh(root, status) {
  const me = await api(ENDPOINTS.me);
  if (me.ok && me.data?.user) { renderSignedIn(root, status, me.data); setView(root, 'signed-in'); return true; }
  if (me.status === 503) { setEnabled(root, false); setView(root, 'disabled'); return false; }
  setView(root, 'signed-out');
  return false;
}

function bindForms(root, status) {
  const submit = (selector, handler) => {
    const form = root.querySelector(selector);
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      flash(root, '');
      try { await handler(new FormData(form), form); } catch { flash(root, 'Something went wrong. Please try again.', 'error'); }
      button.disabled = false;
    });
  };
  submit('[data-account-login]', async (fields) => {
    const result = await api(ENDPOINTS.login, { method: 'POST', body: { email: fields.get('email'), password: fields.get('password') } });
    if (!result.ok) { flash(root, errorMessage(result), 'error'); return; }
    await refresh(root, status);
  });
  submit('[data-account-register]', async (fields, form) => {
    if (fields.get('password') !== fields.get('confirm')) { flash(root, 'Passwords do not match.', 'error'); return; }
    const result = await api(ENDPOINTS.register, { method: 'POST', body: { email: fields.get('email'), password: fields.get('password'), name: fields.get('name') || undefined } });
    if (!result.ok) { flash(root, errorMessage(result), 'error'); return; }
    form.reset();
    if (status.accounts?.email_verification) { flash(root, 'Account created. Check your email for a verification link before signing in.', 'success'); return; }
    const login = await api(ENDPOINTS.login, { method: 'POST', body: { email: fields.get('email'), password: fields.get('password') } });
    if (login.ok) await refresh(root, status); else flash(root, 'Account created. Sign in to continue.', 'success');
  });
  submit('[data-account-forgot]', async (fields, form) => {
    await api(ENDPOINTS.forgot, { method: 'POST', body: { email: fields.get('email') } });
    form.reset();
    flash(root, 'If that address has an account, a password reset email is on its way.', 'success');
  });
  submit('[data-account-profile-form]', async (fields) => {
    const me = await api(ENDPOINTS.me);
    if (!me.ok) { flash(root, errorMessage(me), 'error'); return; }
    const result = await api(`${API}/users/${encodeURIComponent(me.data.user.id)}`, { method: 'PATCH', body: { name: fields.get('name') || null } });
    if (!result.ok) { flash(root, errorMessage(result), 'error'); return; }
    flash(root, 'Profile updated.', 'success');
    await refresh(root, status);
  });
  submit('[data-account-password-form]', async (fields, form) => {
    if (fields.get('password') !== fields.get('confirm')) { flash(root, 'Passwords do not match.', 'error'); return; }
    const me = await api(ENDPOINTS.me);
    if (!me.ok) { flash(root, errorMessage(me), 'error'); return; }
    const result = await api(`${API}/users/${encodeURIComponent(me.data.user.id)}`, { method: 'PATCH', body: { password: fields.get('password') } });
    if (!result.ok) { flash(root, errorMessage(result), 'error'); return; }
    form.reset();
    flash(root, 'Password changed.', 'success');
  });
  submit('[data-account-key-form]', async (fields, form) => {
    const result = await api(ENDPOINTS.apiKeys, { method: 'POST', body: { label: fields.get('label') || undefined } });
    if (!result.ok) { flash(root, errorMessage(result), 'error'); return; }
    form.reset();
    const reveal = root.querySelector('[data-account-key-reveal]');
    reveal.hidden = false;
    reveal.querySelector('code').textContent = result.data.key;
    await refresh(root, status);
  });
  root.querySelector('[data-account-portal]')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    const result = await api(ENDPOINTS.portal, { method: 'POST' });
    if (!(result.ok && redirectToStripe(result.data?.url))) { flash(root, errorMessage(result), 'error'); event.target.disabled = false; }
  });
  root.querySelector('[data-account-logout]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const result = await api(ENDPOINTS.logout, { method: 'POST' });
    button.disabled = false;
    // Only the server can end the session. When the request fails (an outage answered by Caddy,
    // for example) the session cookie is still valid, so the page stays signed in and says so
    // rather than showing a shared device as signed out while a reload would sign it back in.
    if (!result.ok) {
      flash(root, `Sign-out could not be confirmed, so you are still signed in on this device. ${errorMessage(result, 'Please try again.')}`, 'error');
      return;
    }
    root.querySelector('[data-account-key-reveal]').hidden = true;
    flash(root, 'Signed out.', 'info');
    setView(root, 'signed-out');
  });
  root.querySelector('[data-account-show-forgot]')?.addEventListener('click', () => {
    const forgot = root.querySelector('[data-account-forgot]');
    forgot.hidden = !forgot.hidden;
  });
}

/** Entry point for /account. */
export async function mountAccountPage(root) {
  if (!root) return;
  setView(root, 'loading');
  const status = await fetchStatus();
  if (!status.enabled) { setEnabled(root, false); setView(root, 'disabled'); return; }
  setEnabled(root, true);
  root.querySelector('[data-account-register-card]').hidden = status.accounts?.registration !== 'open';
  consumeQueryFlash(root);
  bindForms(root, status);
  await refresh(root, status);
}

/** Entry point for /account/verify?token=… */
export async function mountVerifyPage(root) {
  if (!root) return;
  const output = root.querySelector('[data-verify-result]');
  const token = new URL(window.location.href).searchParams.get('token');
  history.replaceState({}, '', window.location.pathname);
  const status = await fetchStatus();
  if (!status.enabled) { setView(root, 'disabled'); return; }
  setView(root, 'result');
  if (!token || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) { output.textContent = 'This verification link is incomplete. Open the link from your email again.'; return; }
  const result = await api(`${ENDPOINTS.verify}/${encodeURIComponent(token)}`, { method: 'POST' });
  if (result.ok) { window.location.replace('/account?verified=1'); return; }
  output.textContent = result.status === 400 ? 'This verification link is invalid or has already been used.' : errorMessage(result);
}

/** Entry point for /account/reset-password?token=… */
export async function mountResetPage(root) {
  if (!root) return;
  const token = new URL(window.location.href).searchParams.get('token');
  history.replaceState({}, '', window.location.pathname);
  const status = await fetchStatus();
  if (!status.enabled) { setEnabled(root, false); setView(root, 'disabled'); return; }
  if (!token || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) { setView(root, 'disabled'); flash(root, 'This reset link is incomplete. Request a new one from the account page.', 'error'); return; }
  setEnabled(root, true);
  setView(root, 'form');
  root.querySelector('[data-reset-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    if (fields.get('password') !== fields.get('confirm')) { flash(root, 'Passwords do not match.', 'error'); return; }
    form.querySelector('button').disabled = true;
    const result = await api(ENDPOINTS.reset, { method: 'POST', body: { token, password: fields.get('password') } });
    if (result.ok) { window.location.replace('/account?reset=1'); return; }
    flash(root, result.status === 400 ? 'This reset link is invalid or has expired. Request a new one from the account page.' : errorMessage(result), 'error');
    form.querySelector('button').disabled = false;
  });
}
