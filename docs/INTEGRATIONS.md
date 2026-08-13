# Integration guide

All integration surfaces below are public, keyless, static **beta** surfaces. They are free to access today, but there is no uptime, support, or SLA commitment. Public access is not a grant of reuse rights: this repository currently has no license. Before production reuse, an integration team must review the repository's licensing status and obtain or confirm the permission it needs.

The managed gateway under design does not change that model. The static [managed gateway v1 foundation contract](https://worldhotlines.org/gateway/v1/README.md) is **not deployed** and contains synthetic examples only. A future hosted layer may offer organizational authentication, quotas, administration, and operational assurance, but it will not remove or key-gate the current free static API, feeds, widget, or data. There is no pricing and no uptime, support, or SLA commitment.

## Choose a surface

| Need | Use | Trade-off |
| --- | --- | --- |
| Send a person to a maintained interface | [Public finder](https://worldhotlines.org/find-help) | Least integration work; the person leaves your product. |
| Build your own local interface or routing | [Static API v1](https://worldhotlines.org/api/v1/manifest.json) | Full presentation control; you own caching, errors, accessibility, and safety context. |
| Embed a ready-made local resolver | [Widget v1](https://worldhotlines.org/widget) | Fastest embed; Shadow DOM and CSP requirements apply. |
| Review or process the canonical snapshot | [Direct snapshot (`hotlines.json`)](https://raw.githubusercontent.com/craigrallen/world-emergency-hotlines/main/hotlines.json) | Direct, unversioned branch snapshot; schema handling, updates, and permission review are yours. |

Prefer a finder link when embedding crisis data is not essential. Prefer API v1 over the direct snapshot for a versioned integration contract.

## Copy/paste examples

```js
const base = 'https://worldhotlines.org/api/v1';
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
<script src="https://worldhotlines.org/widget/v1/hotlines-widget.js" defer></script>
<world-emergency-hotlines country="us" category="mental_health" max-results="6"></world-emergency-hotlines>
```

Full contracts: [API v1](API.md) and [widget v1](WIDGET.md).

## Architecture, versions, and caching

The site, API, data downloads, and widget are statically built. API consumers fetch a manifest and country artifact, then run the deterministic resolver locally; there is no hosted resolver query endpoint. The widget follows the same model in the visitor's browser. The `/api/v1/` and `/widget/v1/` URLs are mutable deployment paths, not immutable artifact addresses. Pin the major `v1` paths, respect HTTP caching, and periodically revalidate the manifest, `resolver.js`, and `hotlines-widget.js` independently on a bounded schedule appropriate to your risk review.

The manifest's `dataset_version` is the canonical data SHA-256 and identifies canonical data only. It does not identify resolver, widget, site, or build code. The deterministic [release descriptor](https://worldhotlines.org/release/v1/release.json) and [artifact index](https://worldhotlines.org/release/v1/artifacts.json) provide unsigned exact-byte SHA-256 values plus independent finite-source-set generator, resolver, and widget identities. Refresh country and record artifacts when `dataset_version` changes, but also test and review resolver and widget implementation changes even when that dataset hash is unchanged. API/data manifests contain an ISO `generated_at` build timestamp; only the release descriptor has `generated_at: null`. `SOURCE_DATE_EPOCH` must be set to reproduce timestamp-bearing artifacts byte-for-byte. A changed artifact byte changes the index digest and `release_id`, even when dataset and finite-source build identities stay unchanged.

Dataset-release consumers can discover deterministic metadata-only history at `/release/v1/changes.json` and `/release/v1/changes/latest.json`. Factual public release summaries are also available as JSON Feed 1.1, RSS 2.0, and Atom 1.0 under `/feeds/`. These static files contain no subscriber identifiers or crisis-query activity. They are covered by the artifact index and descriptor relationships; the index and descriptor exclude themselves to avoid circular identity.

## Release notifications — design contract

The static, versioned [/subscriptions/v1/ design contract](https://worldhotlines.org/subscriptions/v1/README.md) specifies a privacy-minimised event envelope, illustrative future subscription request/response/error schemas, a proposed OpenAPI 3.1 surface, webhook signing and retry rules, and synthetic fixtures. It is **not a live subscription service**: no signup or POST endpoint is deployed, and this project does not collect destination URLs, contacts, subscriber records, crisis queries, user identifiers, locations, or behaviour.

The zero-registration options available now are [JSON Feed](https://worldhotlines.org/feeds/releases.json), [RSS](https://worldhotlines.org/feeds/releases.rss), and [Atom](https://worldhotlines.org/feeds/releases.atom). A future managed product could provide hosted webhook delivery, retries, and operational assurance, but there are no prices or SLA commitments and the free feeds and static data would not be withheld. Technical filters are deliberately limited to release event type, API major, and artifact class—not country, category, provider/hotline, query, person, location, or behaviour.

Repository tests exercise API v1, resolver v1, and widget v1 together; compatibility metadata claims only that combination. The checksums detect mismatch after a descriptor is obtained through a trusted channel, but do not authenticate the publisher or prove freshness. See the [human-readable release guide](https://worldhotlines.org/release) for verification commands, cache revalidation, rollback guidance, and limitations, and the [static status page](https://worldhotlines.org/status) for build-time evidence that explicitly is not live monitoring.

Hosted Web CI separately runs `npm run verify:caddy`, which uses Docker Caddy 2.10 to validate the configuration and serve a tiny local fixture while checking release GET, HEAD, OPTIONS, headers, and 404 behavior. It is intentionally outside ordinary `npm test`/`verify:all`; local execution requires Docker and curl.

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
- Pin v1 URLs; independently revalidate the release descriptor, manifest, resolver, and widget; verify exact-byte checksums; record the reviewed release and `dataset_version`; test code changes even when canonical data is unchanged; and rehearse rollback/update handling.
- Review [capability packaging](PACKAGING.md), run the testing checklist, and ensure product copy states the beta and verification limitations.
