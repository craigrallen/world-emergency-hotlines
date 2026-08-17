# Licensed managed delivery terms — internal counsel-review draft v1

**INTERNAL ONLY — NOT ACTIVE TERMS, LEGAL ADVICE, APPROVAL, OR A PUBLIC OFFER. Qualified counsel must review and approve any terms before use. Licensing remains held.**

This draft describes a possible future authenticated service. It does not govern the existing public, keyless, static, cacheable API and does not prevent caching of that API.

## Draft obligations for counsel review

A licensee may transiently render a licensed presentation to an end user only. The licensee must not construct or retain a local or client-side database, derived dataset, offline pack, search index, training/evaluation corpus, mirror, archive, or redistribution feed; combine responses to recreate the dataset; or sell, sublicense, disclose, scrape, export, or redistribute records.

Responses and presentation tokens must be displayed only through the authorized application and tenant. The canonical record revision and presentation token must remain visible in the parties' agreed machine-readable rendering metadata for each presentation; hiding them only in an inaccessible store does not satisfy this draft obligation. The licensee must honor `private, no-store, max-age=0` and prevent storage in browsers, application caches, CDNs, service workers, proxies, logs, analytics, queues, crash reports, backups, and observability systems. Temporary operational bytes must be deleted as soon as the render completes and in every case within a counsel-approved deletion window; the exact window remains unresolved.

A future service may require privacy-bounded render attestations containing only tenant/app identity, presentation-token digest, record revision, coarse time bucket, bounded render count, and app version. It may perform bounded aggregate traffic-shape testing and compare metadata-only opaque aliases/canaries observed outwardly. It must never collect end-user identity, IP address, location, crisis query/category, selected hotline, phone/SMS/chat interaction, free text, session replay, or high-cardinality user/session fingerprints through this mechanism.

The licensee would permit proportionate audits and synthetic compliance tests, maintain deletion evidence, cooperate with key rotation/revocation, and promptly notify the service owner of suspected leakage, stale caching, compromise, or redistribution. Exact audit scope, testing notice, deletion deadline, notification deadline, remedies, jurisdiction, privacy roles, retention, and security terms require counsel/privacy/security decisions.

Tokens, aliases, canaries, render-to-fetch ratios, nonces, and traffic patterns are corroborating evidence only. In particular, a bounded render count greater than its comparable bounded fetch count can be consistent with one fetch supporting multiple presentations, but the ratio is not proof of caching, breach, attribution, or wrongdoing. No single match, ratio, nonce, or signal is conclusive; missing attestations, zero denominators, false positives, shared infrastructure, retries, clock error, and implementation defects must be investigated with human review.

Safety-critical hotline bytes and routing semantics must never be varied for watermarking. Only presentation metadata may vary; callable numbers, SMS codes, contact URLs/emails, provider identity, geographic scope, eligibility, availability/hours, emergency classification, and routing/fallback semantics remain canonical and byte-identical.

Any future implementation must derive registered tenant/application/version from authenticated credentials, generate observation IDs server-side, and reject client-selected attribution. Every evidence input must have a domain-separated signature verified through bounded active/revoked key and application registries. Render/presentation claims bind to active issued presentations; metadata and privacy-safe binary matches bind to active issued-material records with provenance. Unknown, revoked, tampered, expired, or mismatched evidence is rejected.

Replay prevention requires a shared cross-process durable atomic store claiming token and nonce in tenant/key scope through expiry plus skew; absence, outage, partial claim, or replay fails closed. Binary evidence may contain hashes and bounded acquisition/scan metadata only, never binary contents or hotline/contact payloads. These remain synthetic reference requirements, not active terms.
