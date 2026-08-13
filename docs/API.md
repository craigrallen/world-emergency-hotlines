# Static API v1

The World Emergency Hotlines API v1 is a versioned, read-only set of static JSON and JavaScript artifacts. It requires no API key, account, or server-side query containing a person's location or crisis need.

Base URL:

```text
https://worldhotlines.org/api/v1/
```

## Contract

- API version: `1.0`
- Delivery: static files over HTTPS
- Identity: immutable `weh_...` record IDs
- Dataset version: exact canonical SHA-256 in `sha256:<digest>` form
- Availability semantics: source-backed records, not live service monitoring
- Privacy: resolution can run locally after downloading a country artifact and resolver module
- Compatibility: fields may be added within v1; existing field meanings and paths will not be changed incompatibly
- Deprecation: deprecated records remain addressable in the record index but are excluded by the resolver
- Browser access: `/api/v1/*` is served with `Access-Control-Allow-Origin: *`; only public data is exposed

There is deliberately no hosted `GET /resolve?...` query endpoint in v1. Consumers fetch static artifacts and run deterministic resolution locally. This avoids transmitting sensitive locality/need selections and keeps the deployment cacheable.

## Artifacts

- `manifest.json` — API contract, dataset version, counts, endpoint templates, country index, and limitations
- `records.json` — object keyed by immutable record ID for direct lookup
- `countries/{alpha2}.json` — complete routing input for one country, using lowercase ISO alpha-2 paths
- `resolver.js` — browser/Node ESM resolver shared with the public guided finder

Every manifest, country artifact, and indexed record carries `api_version` and `dataset_version`.

## Record lookup

```js
const base = 'https://worldhotlines.org/api/v1';
const index = await fetch(`${base}/records.json`).then((response) => response.json());
const record = index.records['weh_c2012344042d59a49aae9f5c'];
```

Record fields include canonical contact/provenance fields plus derived:

```json
{
  "scope": "local | county | state | national",
  "channels": {
    "phone": true,
    "text": false,
    "chat": true
  }
}
```

`scope` reflects the recorded geography label. It does not guarantee eligibility or current availability.

## Local resolution

```js
const base = 'https://worldhotlines.org/api/v1';
const { resolveGuidedHelp } = await import(`${base}/resolver.js`);
const country = await fetch(`${base}/countries/us.json`).then((response) => response.json());

const result = resolveGuidedHelp({
  country,
  category: 'mental_health',
  channel: 'phone', // any | phone | text | chat
  locality: 'Wake County', // optional complete geography component
});

console.log(result.scope);    // county
console.log(result.fallback); // false when an exact recorded-locality/channel match exists
console.log(result.reason);   // human-readable explanation
console.log(result.results);  // stable-ID hotline records
```

Resolver output:

- `scope` — `local`, `county`, `state`, `national`, or `country` for broad category fallback
- `reason` — explicit explanation of the match/fallback
- `fallback` — whether locality, channel, category, or broader coverage fallback was used
- `results` — deterministically sorted records; deprecated records excluded

Locality matching is intentionally conservative. A typed locality must equal a complete comma/semicolon/slash-delimited component of the recorded geography. Partial place-name matching is rejected.

## Caching and updates

1. Fetch `manifest.json`.
2. Compare `dataset_version` with the version your integration last processed.
3. Reuse cached artifacts while the version is unchanged.
4. When it changes, fetch required country artifacts or `records.json` again.

`generated_at` is build time, not dataset identity. Use `dataset_version` for cache keys and audit evidence.

## Errors

Because these are static files:

- unknown country paths return normal HTTP `404`
- an unknown record ID returns `undefined` from `records.json`
- network/JSON/import failures must be handled by the consuming application
- resolver results can be empty when no recorded options exist

Always keep a non-digital emergency fallback appropriate to your product and audience. Do not present the directory as live availability information or medical advice.
