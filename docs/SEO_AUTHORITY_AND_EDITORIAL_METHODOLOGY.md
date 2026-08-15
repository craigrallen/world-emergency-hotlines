# SEO authority and editorial methodology

Status: adopted editorial policy with a separately identified implementation backlog. This document describes requirements for how World Hotlines should publish, improve, and responsibly earn recognition for useful work. It does **not** claim that outreach, independent review, named authorship, affiliation, verification, endorsement, licensing, directory inclusion, or partnership has occurred.

## Purpose, safety scope, and non-goals

World Hotlines publishes a source-backed global reference of emergency numbers and crisis-support services. Because a wrong number, scope, or availability statement can cause harm, hotline records and the pages generated from them are safety-sensitive, Your Money or Your Life (YMYL) content. Search visibility is subordinate to contact accuracy, clear uncertainty, accessibility, and rapid correction.

This policy has two purposes:

- define an operational editorial standard for records, country/category pages, metadata, and corrections; and
- describe legitimate ways to make the project's owned work useful and citation-worthy without manipulating search rankings.

This is not a medical service, legal service, emergency dispatcher, suitability assessor, or guarantee that a provider is reachable. It is not a plan to infer a universal emergency number, claim complete coverage, rank providers, or select the "best" service. It does not authorize canonical-data changes, source reuse beyond applicable terms, outreach, submissions, uploads, logo use, or claims about third parties. The repository's existing canonical/preview boundaries in [`data-flow.md`](data-flow.md), record identity rules in [`service-record-contract.md`](service-record-contract.md), and schema in [`../SCHEMA.md`](../SCHEMA.md) remain controlling.

## Current state versus adopted requirements

Three kinds of statement are kept distinct in this document:

- **Currently enforced repository controls.** The schema defines field shapes and verification-status semantics. Existing validation and duplicate-detection tooling surfaces errors or review candidates without resolving service identity. Only the specific preview, promotion, and apply flows documented in [`data-flow.md`](data-flow.md) enforce non-canonical previews, explicit apply intent, or protected-status safeguards where their code and tests demonstrate those controls. Legacy scripts that write directly to canonical data still exist; repository-wide enforcement is incomplete and remains backlog. The existence of those direct writers does not mean they satisfy the adopted review requirements below. Current CI exercises repository-defined validation and tests. The read-only monitor and deterministic workbench described in [`OPERATIONS.md`](OPERATIONS.md) produce review artifacts and do not verify records or change canonical data.
- **Adopted manual requirements.** Normative words such as "must," "require," and "do not" below state the conditions maintainers adopt for approving future canonical-data or content changes. They do not assert that every historical record passed those conditions or that each condition is automated. In particular, independent human review, complete field-level evidence, correction handling, release logging, and rollback are required practices, not claims of complete current operational coverage.
- **Future implementation backlog.** Items explicitly listed under [Prioritized implementation backlog](#prioritized-implementation-backlog) are not yet fully enforced. That backlog includes broader methodology enforcement, formal correction intake and triage, additional date and claim guards, transparency work, generated-content auditing, and any candidate assessment or outreach process.

## Editorial ownership and attribution

Unless a page says otherwise on documented evidence, its editorial content is project-published content. Future changes must follow the adopted review requirements below; this statement does not claim that every existing page received independent human review. Do not invent a named author, fact-checker, reviewer, clinician, medical credential, professional biography, editorial board, or review date. A commit identity is not automatically a public author or clinical reviewer.

Real attribution may be added only when the person has given documented consent for the exact public name, role, credentials, and scope; the role was actually performed; the credential and relevant standing were checked; and a maintainer retains the evidence and approval. Describe the contribution precisely—for example, "reviewed the accessibility wording"—rather than implying that a person verified every number or medically endorsed the project. Remove or amend attribution when consent, role, or credentials no longer support it.

Organizations are named only as providers or sources when the evidence supports that relationship. Observation of a provider, directory, government page, or research resource does not mean that source promotes, reviews, licenses, endorses, or partners with World Hotlines.

## Evidence hierarchy and permitted language

Evidence is assessed per field and per service scope, not merely per domain. A page being official does not make every historical or inferred claim current. Preserve the source URL, capture/access time, provider or contact attribution, relevant passage or structured value, and applicable country/category. Where sources conflict, do not average or silently choose.

Use this order as a review priority, while retaining the repository's exact status semantics:

1. **Provider first-party evidence.** `verified_web` means the number was confirmed against the provider's official website. Say: "The number was confirmed against the provider's official website on [date]." This status does not verify non-number contact channels (website, email, chat, or SMS metadata), eligibility, geography, hours, languages, cost, availability, or broader scope; each requires separate field-level evidence. Do not say "guaranteed active," "approved," or "recommended."
2. **Government or recognized authority evidence.** `verified_authority` means the number was confirmed against a named authoritative body/source, such as a government, national health ministry, WHO, or IFRC. Say: "The number was confirmed against [named authoritative body/source] on [date]." This status does not verify non-number contact channels (website, email, chat, or SMS metadata), eligibility, geography, hours, languages, cost, availability, or broader scope; each requires separate field-level evidence. Do not imply provider confirmation when it was not obtained.
3. **Third-party directory evidence.** `cross_referenced` means the record originated from a third-party public directory; its moderate trust reflects presumed directory diligence. Say: "Originated from [named third-party public directory]; not provider- or authority-verified by this status." This status is not provider or authority verification. Solely as a future editorial preference, maintainers should seek multiple independent observations when reasonably available; that preference is not part of the status semantics and does not establish availability, eligibility, accuracy, or any field or scope claim.
4. **Earlier or minimally attributed material.** `legacy_unverified` means inherited without an independent check. Say: "Unverified legacy lead; confirm with the provider before use." Do not present it as a verified fact.

The repository also contains `verified_knowledge`. The number was asserted from prior training knowledge and was not reconfirmed on the public web. This is not provider, authority, or web verification. It does not verify category, hours, languages, cost, target audience, notes, website, sources, non-number contact channels, eligibility, geography, availability, or broader scope; each requires separate field-level evidence. Do not use it to support new factual prose.

Lifecycle states override promotional presentation:

- `disputed` means material sources conflict. State the conflict and its practical consequence in notes, suppress confident claims, and escalate for review.
- `deprecated` means the service closed or the contact is no longer in use. Keep the immutable record lifecycle and `replaced_by` rules; do not route users to it or describe it as current.

Status is not a provider quality score, recommendation, clinical assessment, or real-time availability signal. Specifically, `verified_web` and `verified_authority` apply only to the number confirmed against the applicable source. They do not verify non-number contact channels (website, email, chat, or SMS metadata), eligibility, geography, hours, languages, cost, availability, or broader scope; each requires separate field-level evidence. `last_verified` records when the number evidence was checked, not when the service was proven continuously operational. Source capture or monitoring is observation, not promotion: the read-only source monitor and preview artifacts can surface evidence but cannot upgrade canonical status or authorize publication.

## Record and page change workflow

Before any future factual canonical-record or generated-page change is approved, maintainers must satisfy and document the applicable gates below. These are adopted manual requirements except where a step explicitly identifies a currently implemented repository control; their presence here does not claim that historical changes completed every gate.

1. **Capture the source.** Record the canonical source URL where available, retrieval time, page title/publisher, and the exact evidence needed for each changed field. Note redirects and inaccessible, ambiguous, translated, or stale content. A search-result snippet alone is insufficient.
2. **Resolve attribution and applicability.** Identify the provider responsible for the contact, the contact channel, the published service area, audience/eligibility, category, hours, languages, and cost only where stated. Confirm the country/territory mapping; never guess geopolitical equivalence or apply one country's number to another.
3. **Preserve the exact contact.** Keep meaningful prefixes, short codes, spacing/display form, extensions, SMS versus voice distinctions, URLs, and email addresses. Normalization may support comparison but must not silently alter the published value. Shared contacts do not prove duplicate services.
4. **Draft conservatively.** Change only fields supported by evidence. Retain explicit unknowns and conflicts. Never mechanically derive structured `service_scope` from free text or categories.
5. **Require independent review.** Someone other than the proposer compares every changed contact and scope claim to the captured evidence, checks status/date semantics and record identity, and records approve/reject/revise. Self-review is insufficient for canonical contact changes. Reviewer artifacts must not fabricate identities.
6. **Exercise generated outputs.** Run canonical validation, duplicate-candidate checks as appropriate, static-data generation, contact-link checks, and affected country/category/search/schema tests. Inspect the rendered contact and safety language. Currently implemented validation and duplicate tooling can surface errors or candidates but does not supply human approval. Generated outputs must use the same canonical input and must not convert a preview into canonical data.
7. **Use change and CI gates.** Prepare a narrowly scoped change with evidence and the required reviewer decision, and require applicable CI to pass before approval. Specific documented flows enforce preview/canonical separation, explicit apply behavior, or protected-status safeguards where their code and tests demonstrate those controls; legacy direct canonical writers do not thereby satisfy this gate. Preview or report generation is not approval. This policy does not claim repository-wide enforcement or that CI enforces every manual evidence, reviewer, date, release, or correction requirement. Protected records must not be overwritten or downgraded.
8. **Release and log.** Record factual changes in the repository's release/change artifacts, retaining stable record IDs, dataset-version/checksum integrity, source attribution, and a concise reason. Never silently delete a record to hide history.
9. **Provide correction and rollback paths.** Corrections must be easy to report without sensitive personal data. A substantiated safety issue triggers containment, review, correction, regeneration, and a release note. Roll back the smallest affected release/change when safe; otherwise mark the record `disputed` or `deprecated` as evidence requires while a reviewed fix proceeds.

## Freshness and dates

Dates use real ISO `YYYY-MM-DD` calendar dates. Reject impossible dates and any `last_verified`, evidence-check, review, publication, or access date later than the trusted current date. Build time is not verification time. A page rebuild must not refresh `last_verified`, `dateModified`, or editorial-review dates unless the underlying fact was actually reviewed or content materially changed.

Freshness is risk-based. Emergency contacts, closure notices, changed routing, and provider-domain changes receive priority; undated third-party listings receive lower confidence. Staleness thresholds may create review queues, but passing a threshold does not prove a record wrong and a recent date does not prove it live. When a source disappears, preserve the observation, try an authoritative replacement, and downgrade, dispute, deprecate, or suppress only through review. Clearly distinguish dataset release date, page build date, source retrieval date, and field verification date.

## Content quality rules

Country and category summaries must be factual syntheses of reviewed dataset fields and cited evidence. They should explain known service scope, contact modes, material limitations, and coverage gaps in plain language. Repeated boilerplate is acceptable only for essential safety notices; it must not masquerade as country-specific research.

Do not publish:

- generic AI filler, paraphrased padding, or programmatic pages with no distinct user value;
- unsupported medical, diagnostic, legal, confidentiality, response-time, cost, accessibility, eligibility, or suitability claims;
- claims that one number works universally, or inference of a contact from region, numbering convention, neighboring country, language, or category;
- invented completeness, comprehensiveness, real-time availability, official status, rankings, ratings, comparisons, "best" claims, or recommendations;
- content primarily produced to capture search queries rather than help a person understand the available evidence; or
- copied third-party descriptions beyond permission, license, and proportionate quotation rules.

Automation may detect changes, build review queues, validate structure, and generate evidence-bound summaries. It may not manufacture evidence or bypass human review. Where information is unknown, say it is unknown or omit the claim.

## Schema and metadata policy

Structured data and metadata must describe what users can see and what the project can substantiate. JSON-LD is descriptive metadata, not proof of accuracy, authority, authorship, endorsement, or search eligibility.

- Use `Dataset` only for a genuinely accessible dataset and accurately describe name, description, URL, distribution/download forms, license (only when established), temporal coverage, version, dates, creator/publisher, and provenance. Keep page content and markup consistent with Google's Dataset guidance and Schema.org's `Dataset` vocabulary.
- Use `Organization` only for World Hotlines' actual project identity and public contact details. Do not list providers, directories, researchers, or authorities as parents, funders, members, partners, or affiliates without documented permission and a real relationship.
- Use `WebSite` only for the actual site, its canonical public URL, and supported site features. Do not invent awards, reviews, ratings, credentials, or ownership.
- Add `author`, `reviewedBy`, credentials, awards, affiliations, citations, or `sameAs` only when accurate, visible, documented, consented where relevant, and semantically correct. Never create them for SEO appearance.
- Keep canonical metadata aligned with the repository's actual public URLs and existing canonical policy. This plan does not authorize canonical changes.
- Do not publish `hreflang` until distinct, valid localized URLs exist with accurate reciprocal mappings. Language names in hotline records do not make the surrounding page localized.

## Citation-worthy owned assets

Authority should follow useful, inspectable work. Improve these owned assets only to the extent they already exist or are separately implemented and verified:

- a public editorial and verification methodology with status definitions, limitations, evidence examples, and change history;
- versioned dataset releases with stable identifiers, checksums, integrity verification, and human-readable changes;
- reproducible coverage, freshness, metadata, and gap reports that keep dimensions separate and explain uncertainty rather than issuing a composite quality score;
- documented API, feeds, and widget interfaces that accurately distinguish public beta, static contracts, proposed designs, and deployed capabilities;
- transparent status/monitoring reports that disclose what is monitored and avoid implying live provider availability; and
- accessible correction, provider-claim, and contribution instructions with privacy, evidence, independent-review, and response expectations.

Do not advertise a planned or synthetic contract as deployed. Do not call a feed live, an endpoint supported, a monitor real-time, a contribution reviewed, or a checksum independently audited unless that capability and event are demonstrably true.

## Legitimate authority-building plan

### Phase 1: asset quality first

Close high-risk accuracy and documentation gaps; make methodology, release provenance, limitations, correction paths, and existing machine-readable assets easy to find. Validate accessibility, generated pages, metadata, stable links, checksums, and claims about deployment. Stop if core contact accuracy, correction handling, licensing, or ownership is unresolved.

### Phase 2: individually assessed candidates

Only after Phase 1 acceptance, maintainers may create a review list of potential audiences—not promised links—including emergency-preparedness educators, public-health or humanitarian data teams, crisis-resource researchers, accessibility organizations, responsible civic-tech projects, libraries, standards/data catalogues, and maintainers of genuinely relevant resource pages.

Each candidate must pass all of these checks before any human-approved contact or submission:

- the audience and specific page are relevant to a real owned asset;
- the asset fills an evidenced need and is publication-ready;
- contact details and terms permit the proposed communication;
- the message is individualized, accurate, low-pressure, and useful without requiring a link;
- no payment, exchange, reciprocal-link condition, ranking promise, endorsement implication, or emergency-routing claim is involved;
- licensing and permitted reuse are understood before offering data or files; and
- a human approves the exact recipient, channel, message, and any attachment or upload.

An eligible candidate is only a candidate. It is not a relationship, approval, citation, endorsement, or contact event.

Truthful short template for optional future human use:

> Subject: Possible resource for [specific page or task]
>
> Hello [name/team], I maintain World Hotlines, a source-backed directory of emergency and crisis-support contacts. Your [specific page/work] appears relevant to our [specific existing asset]. The asset includes [verifiable feature] and clearly states its coverage and verification limits: [URL]. If it is useful to your readers or work, you are welcome to assess it under your normal editorial process. No response or link is expected. Corrections are welcome at [published correction route].

### Phase 3: follow-up and measurement

Allow at most one useful, context-aware follow-up when the recipient's stated terms allow it; otherwise stop. Record approval, message, date, response, correction, referral, and citation outcomes without storing unnecessary personal data. Respect opt-outs immediately. Feed substantive feedback into the editorial queue, not directly into canonical records.

## Hard prohibitions

World Hotlines must not use paid links; gifts or sponsorships conditioned on links; link exchanges or reciprocal requirements; automated, scraped, or bulk outreach; bulk directory submissions; comment or forum spam; private blog networks; expired-domain or redirect manipulation; fake profiles, personas, reviews, traffic, or engagement; fabricated citations; unsupported partner, supporter, client, or authority logos; misleading advertorials; or link attributes and placement intended to manipulate ranking. Do not ask anyone to conceal compensation or use an inappropriate link attribute. Do not produce scaled low-value pages or republish third-party material to attract links.

## Inclusion or submission checklist

Before a future human submits an owned asset anywhere, document:

- the destination's purpose, ownership, editorial policy, moderation, terms, privacy policy, submission rules, fees, and applicable data/content license;
- why the specific asset is relevant and what verifiable value it provides;
- that the listing text, organization description, URL, and capability claims are exact;
- that the destination retains editorial independence and is not required to link, rank, endorse, or reciprocate;
- that inclusion will not be described as partnership, verification, approval, or endorsement;
- that neither World Hotlines nor the destination is claimed to provide emergency routing, live availability, or guaranteed suitability; and
- that no dataset, feed, contact list, or file is uploaded, syndicated, or licensed without documented permission and compatible terms.

Stop if terms are missing or incompatible, ownership is unclear, the site exists mainly to sell links, sensitive data is requested, the listing would mislead users, or permission for upload/reuse is absent.

## Measurement and outcomes

Measure whether the work helps users and improves accountable discovery:

- editorial: correction time, reviewed evidence coverage, stale/conflicting records resolved, generated-output failures prevented, and release integrity;
- useful recognition: relevant citations from editorially independent pages, qualified referral visits, dataset/API/feed use that can be evidenced without invasive tracking, and substantive corrections or contributions;
- search discovery: Search Console impressions, clicks, query/page discovery, indexing/coverage signals, and changes around documented releases, interpreted cautiously and with privacy-safe aggregation; and
- outreach quality, if separately authorized: eligible candidates, human-approved messages, opt-outs, useful replies, earned citations, and corrections—never raw volume.

Domain-authority, domain-rating, backlink-count, and similar third-party scores may be diagnostic leads but are vanity metrics, not objectives or evidence of trust. Do not guarantee rankings, rich results, indexing, traffic, citations, or response. Correlation after a release does not prove causation.

## Incidents and corrections

For future handling under this adopted policy, a report that a contact is wrong, reassigned, harmful, closed, geographically misleading, or presented with unsafe availability/eligibility language must be treated as a safety incident. Maintainers must preserve the report and source without unnecessary personal information; acknowledge it through an available published channel; triage severity and affected outputs; contain misleading routing promptly; independently verify authoritative evidence; correct, dispute, deprecate, or replace through the canonical workflow; regenerate and test all outputs; publish a factual release/correction note; notify known downstream consumers only through authorized channels; and perform a cause review. These are required handling steps, not a claim that complete intake, logging, notification, or rollback operations are currently implemented. Do not silently swap a number or erase the old record lifecycle.

A misleading backlink, listing, or third-party description—such as "official partner," "clinically verified," or "real-time emergency service"—must be captured and assessed. Correct World Hotlines-controlled text immediately. Any request to an external publisher requires human approval and should ask only for factual correction or removal, never a replacement link or ranking benefit. If the publisher does not act, do not repeat the claim; document the unresolved risk and consider search-platform remediation only when policy, evidence, and authorization support it.

## Prioritized implementation backlog

Owners below are roles, not claims about assigned people. No target date or completed work is implied.

1. **P0 — Publish and enforce the methodology.** Owner: Editorial maintainer. Evidence: this policy, linked repository contracts, and change history. Acceptance: README discoverability; status language matches schema; no unsupported people or relationships; Markdown/source-term checks pass. Stop on contradiction with canonical safety contracts.
2. **P0 — Formalize safety correction intake and triage.** Owner: Safety editor. Evidence: public route, privacy rules, severity rubric, audit example, and rollback procedure. Acceptance: a synthetic wrong-number exercise reaches containment, independent review, regenerated outputs, and release note without canonical bypass. Stop if reports could expose personal crisis information or auto-edit contacts.
3. **P0 — Add date and claim guards.** Owner: Data quality maintainer. Evidence: validator fixtures for impossible/future dates and metadata/status mismatches. Acceptance: deterministic tests reject future/invalid dates and build timestamps cannot refresh verification dates. Stop if the trusted-date source or timezone behavior is ambiguous.
4. **P1 — Improve owned transparency assets.** Owner: Documentation maintainer. Evidence: methodology, version/checksum documentation, coverage/freshness/gap definitions, and accurate capability matrix. Acceptance: every public capability claim maps to a working artifact/test or is clearly labeled proposed/synthetic/not deployed. Stop on licensing or provenance uncertainty.
5. **P1 — Audit generated content and structured data.** Owner: Web/SEO maintainer. Evidence: sampled country/category pages and extracted JSON-LD. Acceptance: visible copy is evidence-derived; Dataset/Organization/WebSite fields agree with reality; no fake attribution, affiliation, award, or hreflang; relevant build, link, SEO, and trust tests pass. Stop if generation creates unsupported claims at scale.
6. **P2 — Prepare candidate assessment, without contact.** Owner: Communications reviewer. Evidence: candidate-class rubric and completed eligibility records for individually researched examples. Acceptance: each record has relevance, terms, licensing, asset, risks, proposed truthful message, and human approval fields; no message is sent by this task. Stop if Phase 1 is incomplete or a recipient forbids contact.
7. **P3 — Run a bounded human-approved pilot only under separate authorization.** Owner: Human outreach approver. Evidence: explicit approval for each recipient/message and an outcome log. Acceptance: low volume, no prohibited tactic, opt-outs honored, corrections routed editorially, and usefulness measured beyond link count. Stop on complaint, terms conflict, inaccurate claim, automation pressure, or safety/licensing concern.
8. **P3 — Review outcomes and retire weak tactics.** Owner: Analytics reviewer. Evidence: privacy-safe editorial, referral, citation, and Search Console measures with release annotations. Acceptance: conclusions separate observation from causation and do not promise rankings. Stop tactics that generate irrelevant traffic, low-quality citations, burden recipients, or incentivize unsafe content.

## References

Accessed 2026-08-15. External pages, policies, redirects, and vocabularies can change; re-check the current version before implementation.

- [Google Search spam policies](https://developers.google.com/search/docs/essentials/spam-policies) — prohibited manipulative and scaled-abuse patterns.
- [Google guidance on creating helpful, reliable, people-first content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content) — audience purpose, evidence, authorship, and trust considerations.
- [Google Dataset structured-data guidance](https://developers.google.com/search/docs/appearance/structured-data/dataset) — Dataset eligibility and field guidance; markup does not guarantee a search feature.
- [Schema.org Dataset](https://schema.org/Dataset) — vocabulary reference for dataset descriptions.
- [Find A Helpline: About](https://findahelpline.com/about) — example/research input concerning a third-party directory; no endorsement, permission, licensing, review, affiliation, or partnership is implied.
- [Befrienders Worldwide](https://befrienders.org/) — example/research input and potential audience class; no endorsement, permission, licensing, review, affiliation, or partnership is implied.
- [IASP crisis centres URL](https://www.iasp.info/resources/Crisis_Centres/) — external research/context example only; no current directory, endorsement, permission, licensing, affiliation, or partnership is implied.
- [Humanitarian Data Exchange documentation](https://docs.humdata.org/about/about-the-humanitarian-data-exchange) — external research/context example only; no current directory, endorsement, permission, licensing, affiliation, or partnership is implied.
