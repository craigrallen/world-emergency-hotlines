import assert from 'node:assert/strict';
const origin = 'http://localhost:3000';
let status;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try { const response = await fetch(`${origin}/cms/api/account/status`); if (response.ok) { status = await response.json(); break; } } catch { /* wait for startup */ }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.equal(status?.component, 'cms', 'Production CMS did not become healthy');
assert.equal(status.stripe.mode, 'disabled');
assert.equal(status.accounts.registration, 'closed');
assert.equal(status.free_static_surfaces_unchanged, true);
const login = await fetch(`${origin}/cms/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email: process.env.CMS_ADMIN_EMAIL, password: process.env.CMS_ADMIN_PASSWORD }) });
assert.equal(login.status, 200);
assert.equal((await login.json()).user.role, 'admin');
const first = await fetch(`${origin}/cms/api/users/first-register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(first.status, 403);
const admin = await fetch(`${origin}/admin/login`);
assert.equal(admin.status, 200);
assert.match(await admin.text(), /<html/);
console.log('Production status, bootstrap login, first-user refusal, and admin HTML smoke passed.');
