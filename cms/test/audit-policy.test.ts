import { expect, test } from 'vitest';
import { checkAudit } from '../scripts/audit-policy.mjs';
const advisory = { url: 'https://github.com/advisories/GHSA-jg8r-5jh2-v2xj', severity: 'moderate' };
const lock = { packages: { 'node_modules/payload': { version: '3.88.0' } } };
const report = () => ({ auditReportVersion: 2, metadata: { vulnerabilities: { moderate: 2 } }, vulnerabilities: { payload: { via: [advisory], nodes: ['node_modules/payload'] }, '@payloadcms/ui': { via: ['payload'] } } });
test('audit names reviewed residuals and permits their transitive impact only', () => {
  expect(checkAudit(report(), lock, '2026-09-08')).toEqual(['GHSA-jg8r-5jh2-v2xj']);
});
test('audit refuses unavailable reports, new advisories, changed versions and expired reviews', () => {
  expect(() => checkAudit({ error: 'offline' }, lock)).toThrow();
  expect(() => checkAudit(report(), lock, '2026-10-09')).toThrow(/expired/);
  expect(() => checkAudit(report(), { packages: { 'node_modules/payload': { version: '3.89.0' } } }, '2026-09-08')).toThrow(/versions/);
  const changed = report(); changed.vulnerabilities.payload.via = [{ ...advisory, url: 'https://github.com/advisories/GHSA-unknown' }];
  expect(() => checkAudit(changed, lock, '2026-09-08')).toThrow(/Unreviewed/);
});
