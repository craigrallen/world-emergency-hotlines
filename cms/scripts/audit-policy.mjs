import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Exact affected installations, not package-name or severity-wide exemptions.
export const exceptions = Object.freeze({
  'GHSA-jg8r-5jh2-v2xj': { package: 'payload', nodes: { 'node_modules/payload': '3.88.0' }, severity: 'moderate', expires: '2026-10-08', reason: 'Runtime dependency; explicitly restricted access.unlock=isAdmin, covered by REST tests. Upstream has no patch at review time.' },
});

export function checkAudit(report, lock, today = new Date().toISOString().slice(0, 10)) {
  if (report?.error || report?.auditReportVersion !== 2 || !report.vulnerabilities || !report.metadata?.vulnerabilities) throw new Error('Audit unavailable or malformed; this is not a clean audit');
  const accepted = new Set();
  const visit = (name, path = new Set()) => {
    if (path.has(name)) return new Set();
    const found = new Set();
    const entry = report.vulnerabilities[name];
    if (!entry || !Array.isArray(entry.via) || !entry.via.length) throw new Error(`Unresolved advisory: ${name}`);
    for (const via of entry.via) {
      if (typeof via === 'string') { for (const id of visit(via, new Set([...path, name]))) found.add(id); continue; }
      const id = /^https:\/\/github\.com\/advisories\/(GHSA-[\w-]+)$/.exec(via.url ?? '')?.[1];
      const rule = exceptions[id];
      if (!rule || rule.package !== name || rule.severity !== via.severity || today > rule.expires) throw new Error(`Unreviewed, changed or expired advisory: ${name} ${id ?? via.url}`);
      if (!entry.nodes?.length || entry.nodes.some((node) => !rule.nodes[node] || lock.packages[node]?.version !== rule.nodes[node])) throw new Error(`Affected dependency paths/versions changed: ${name}`);
      found.add(id);
    }
    return found;
  };
  for (const name of Object.keys(report.vulnerabilities)) {
    const found = visit(name);
    if (!found.size) throw new Error(`Unresolved advisory chain: ${name}`);
    for (const id of found) accepted.add(id);
  }
  return [...accepted];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = spawnSync('npm', ['audit', '--omit=dev', '--json', '--userconfig=/dev/null'], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || ![0, 1].includes(result.status)) throw new Error('npm audit failed to run');
    const accepted = checkAudit(JSON.parse(result.stdout), JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')));
    if (!accepted.length) console.log('Production dependency audit is clean.');
    for (const id of accepted) console.log(`REVIEWED RESIDUAL ${id} (expires ${exceptions[id].expires}): ${exceptions[id].reason}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
