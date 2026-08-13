# Draft design-partner pilot brief

**Internal/reviewable draft only.** Enrollment is not stated or implied to be open, and this document is not an offer or promise of availability.

## Intended fit and exclusions

Potential fit is an organization evaluating a public, keyless, client-side finder/API/widget in a partner-controlled non-production channel, with engineering, accessibility, safety, privacy, legal, and content-review owners. Exclude clinical decision support, emergency dispatch, real-time case management, production dependency, covert measurement, service ranking, and any workflow that needs guaranteed coverage, availability, response, verification, compliance, or outcomes.

## Bounded 4–6 week shape

1. Week 1: written scope, roles, licensing/permission review, threat model, data flow, and synthetic test plan.
2. Weeks 2–3: partner integrates a pinned v1 surface in a partner-controlled test channel.
3. Weeks 3–4: synthetic functional, fallback, accessibility, privacy, and failure testing.
4. Weeks 4–6: bounded evidence review, decision record, teardown or separately approved next step.

The exact schedule, work, responsibilities, and any continuation are subject to written agreement. This draft promises neither immediate response nor staff capacity.

## Responsibilities subject to written agreement

Partner responsibilities: control the channel; use only synthetic/non-personal scenarios; obtain internal legal/privacy/accessibility/security approval; confirm reuse permission; prevent production or real-crisis use; provide named test owners; preserve limitations and emergency fallback; and remove the integration at stop/end.

Project responsibilities: provide links to existing public beta documentation and artifacts, clarify documented behavior, receive bounded non-sensitive technical evidence, and identify documentation defects. No service availability, support, verification SLA, clinical suitability, legal compliance, or emergency outcome is promised.

## Discovery questions

- Which user-facing problem and partner-controlled test channel are in scope?
- Why is a link insufficient, and which API/widget/snapshot capability is required?
- Who owns safety, privacy, accessibility, security, legal/licensing, and teardown decisions?
- What data crosses each boundary, and how is personal or crisis-case data prevented?
- Which synthetic countries, categories, channels, fallback levels, failures, and assistive technologies will be tested?
- What evidence permits continuation, and who can stop the pilot immediately?

## Integration readiness and safety/privacy review

- [ ] Written scope, exclusions, duration, owners, and stop authority agreed.
- [ ] Repository licensing status and required permission reviewed.
- [ ] Partner-controlled, access-limited test channel confirmed; no real crisis case studies.
- [ ] Synthetic/non-personal test fixtures only; no identifiable user data or free text.
- [ ] No telemetry unless a separately qualified privacy/legal-reviewed, customer-boundary technical-health design meets `PRIVACY_SAFE_METRICS.md`.
- [ ] Static beta, verification, scope, fallback, and no-live-availability copy remains visible.
- [ ] CSP, failure modes, cached-data behavior, accessibility, and non-digital fallback tested.
- [ ] Teardown and evidence deletion rehearsed.

## Success and stop criteria

Success means the agreed synthetic scenarios behave deterministically; scope/fallback and evidence limitations remain understandable; no personal data crosses the agreed boundary; accessibility checks pass; failure states are safe; and the team produces a documented continue/stop decision. It does not mean contact success, clinical benefit, legal compliance, service availability, or emergency outcome.

Stop immediately for real or identifiable crisis data, use by distressed individuals, unsafe or misleading routing, hidden limitations, privacy/security leakage, inaccessible critical actions, unapproved telemetry, inability to provide fallback, licensing/permission uncertainty, scope expansion, or lack of an accountable owner. Stop also at the timebox unless a new written agreement exists.

## Feedback/evidence template

```text
Pilot scope and dates:
Partner-controlled channel:
Owners and stop authority:
Artifact URLs and dataset_version:
Synthetic scenario ID (no personal data):
Expected / observed result:
Fallback and verification presentation:
Accessibility and failure checks:
Privacy/security observation:
Documentation defect:
Severity and mitigation:
Evidence retention/deletion date:
Continue / stop decision and rationale:
```
