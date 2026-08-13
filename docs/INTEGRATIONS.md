# Integration guide

All integration surfaces below are public, keyless, static **beta** surfaces. They are free to access today, but there is no uptime, support, or SLA commitment. Public access is not a grant of reuse rights: this repository currently has no license. Before production reuse, an integration team must review the repository's licensing status and obtain or confirm the permission it needs.

## Choose a surface

| Need | Use | Trade-off |
| --- | --- | --- |
| Send a person to a maintained interface | [Public finder](https://world-emergency-hotlines-production.up.railway.app/find-help) | Least integration work; the person leaves your product. |
| Build your own local interface or routing | [Static API v1](https://world-emergency-hotlines-production.up.railway.app/api/v1/manifest.json) | Full presentation control; you own caching, errors, accessibility, and safety context. |
| Embed a ready-made local resolver | [Widget v1](https://world-emergency-hotlines-production.up.railway.app/widget) | Fastest embed; Shadow DOM and CSP requirements apply. |
| Review or process the canonical snapshot | [Direct snapshot (`hotlines.json`)](https://raw.githubusercontent.com/craigrallen/world-emergency-hotlines/main/hotlines.json) | Direct, unversioned branch snapshot; schema handling, updates, and permission review are yours. |

Prefer a finder link when embedding crisis data is not essential. Prefer API v1 over the direct snapshot for a versioned integration contract.

## Copy/paste examples

```js
const base = 'https://world-emergency-hotlines-production.up.railway.app/api/v1';
const manifest = await fetch(`${base}/manifest.json`).then((response) => {
  if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
  return response.json();
});
const country = await fetch(`${base}/countries/us.json`).then((response) => {
  if (!response.ok) throw new Error(`country HTTP ${response.status}`);
  return response.json();
});
const { resolveGuidedHelp } = await import(`${base}/resolver.js`);
const result = resolveGuidedHelp({ country, category: 'mental_health', channel: 'phone' });
console.log(manifest.dataset_version, result.results);
```

```html
<script src="https://world-emergency-hotlines-production.up.railway.app/widget/v1/hotlines-widget.js" defer></script>
<world-emergency-hotlines country="us" category="mental_health" max-results="6"></world-emergency-hotlines>
```

Full contracts: [API v1](API.md) and [widget v1](WIDGET.md).

## Architecture, versions, and caching

The site, API, data downloads, and widget are statically built. API consumers fetch a manifest and country artifact, then run the deterministic resolver locally; there is no hosted resolver query endpoint. The widget follows the same model in the visitor's browser. The `/api/v1/` and `/widget/v1/` URLs are mutable deployment paths, not immutable artifact addresses. Pin the major `v1` paths, respect HTTP caching, and periodically revalidate the manifest, `resolver.js`, and `hotlines-widget.js` independently on a bounded schedule appropriate to your risk review.

The manifest's `dataset_version` is the canonical data SHA-256 and identifies canonical data only. It does not identify resolver, widget, site, or build code. Refresh country and record artifacts when `dataset_version` changes, but also test and review resolver and widget implementation changes even when that dataset hash is unchanged. No per-artifact code digest is currently provided; do not treat `generated_at` as an artifact identity or infer compatibility across future major paths.

## Failure and fallback handling

- Treat HTTP errors, timeouts, invalid JSON, module-load errors, unknown countries, and empty resolver results as ordinary failure states. Never replace them with a guessed number.
- Show a plain-language unavailable state and retain an appropriate non-digital emergency fallback. Do not imply that a fallback result is local, eligible, open, or reachable.
- Preserve resolver `scope`, `fallback`, and `reason`; locality matching is deliberately exact and broader category/channel/geography fallback can occur.
- Keep the last reviewed artifact only if your policy permits it, label its dataset version, and never describe cached data as live availability.

## Accessibility and safety presentation

Use semantic headings, labelled controls, keyboard-operable actions, visible focus, sufficient contrast, and text—not colour alone—for verification and fallback state. Keep immediate-danger guidance visible. Announce asynchronous errors/results without moving focus unexpectedly. Test zoom, narrow screens, reduced motion, screen readers, and keyboard-only use. Do not rank services by clicks or hide verification, geography, eligibility, hours, cost, or source context.

## Security, CSP, and privacy

Use HTTPS, validate JSON shape and allowed enum values, escape all displayed data, and do not turn dataset strings into executable markup. For the widget allow the production origin in `script-src` and `connect-src`; its runtime Shadow DOM styles may require an inline-style policy acceptable to the host. Review CSP in the [widget guide](WIDGET.md). No API key or cookie is required.

Resolution can remain client-side so locality, need, and channel selections are not sent to this project. Do not place sensitive values in URLs, logs, analytics, server-rendered attributes, or referers. This repository does not implement or enable integration telemetry. Any customer-controlled aggregate measurement must follow [the privacy-safe metrics contract](PRIVACY_SAFE_METRICS.md).

## Verification and scope limitations

Listings are source-backed directory records, not live availability checks, medical advice, clinical suitability, legal compliance, eligibility, or successful-contact guarantees. Verification statuses describe the recorded evidence and review method; they do not prove current operation. Geography describes recorded scope, not the user's identity or eligibility. Coverage and metadata depth vary, and numbers, hours, services, and official guidance can change. Review the cited provider or authority source at the point your production process requires.

## Testing checklist

- Exercise valid, unknown, empty, offline, timeout, malformed-response, and CSP-blocked cases.
- Test every supported country/category/channel and each fallback level with synthetic, non-personal inputs.
- Confirm displayed `dataset_version`, scope, fallback reason, verification state, and source context.
- Test keyboard, screen reader, zoom, contrast, narrow layouts, and host-page CSS isolation.
- Confirm no private selections enter requests, URLs, logs, analytics, or error reports.

## Production readiness checklist

- Confirm reuse permission and current repository licensing status; no repository license exists today.
- Document owners for data review, cache refresh, incident handling, accessibility, privacy, and legal review.
- Define safe degraded behavior and a non-digital emergency fallback without relying on an uptime commitment.
- Pin v1 URLs; independently revalidate the manifest, resolver, and widget; validate artifacts; record the reviewed `dataset_version`; test code changes even when it is unchanged; and rehearse rollback/update handling.
- Review [capability packaging](PACKAGING.md), run the testing checklist, and ensure product copy states the beta and verification limitations.
