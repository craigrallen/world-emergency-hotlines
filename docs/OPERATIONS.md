# Verification operations

Phase 7 provides public intake and deterministic reviewer artifacts. It does not create verified records, provide counselling, test-call services, or change the canonical dataset.

## Public intake and privacy

Use the [hotline correction form](https://github.com/craigrallen/world-emergency-hotlines/issues/new?template=hotline-correction.yml) for an existing listing and the [provider/new-service form](https://github.com/craigrallen/world-emergency-hotlines/issues/new?template=provider-submission.yml) for an official organization. Issues are public. Never include personal crisis stories, health details, names of people seeking help, or other sensitive personal data. Submissions are unverified review leads; review and publication are not guaranteed. For immediate danger, contact local emergency services—the repository does not provide crisis counselling.

## Read-only monitor

The source monitor visits a bounded deterministic set of canonical public HTTP(S) website/source URLs. It rejects unsafe destinations and redirects, keeps TLS verification enabled, and caps redirects, bytes, request time, and URL count. Artifacts retain hashes and contact-presence observations, not page bodies, cookies, headers, or URL queries.

```sh
python scripts/source_monitor.py --as-of 2026-08-13 --limit 25 \
  --json-output /tmp/source-snapshot.json --markdown-output /tmp/source-report.md
```

An optional strictly validated `--previous` snapshot enables canonical-source-identity comparison. Previous URLs are keys only and never fetch inputs. Query- or fragment-bearing URLs and credentials are ineligible and are never requested or emitted. Every DNS answer must be public, the selected address is pinned through TCP, and the connected peer is revalidated; HTTPS retains the original hostname for SNI and certificate verification. A redirect, failure, changed hash, or missing listed contact is only a review prompt; it never proves validity or availability and never updates verification fields.

## Workbench

```sh
python scripts/freshness_report.py --as-of 2026-08-13 --json-report /tmp/freshness.json
python scripts/verification_workbench.py --as-of 2026-08-13 \
  --freshness /tmp/freshness.json --source-monitor /tmp/source-snapshot.json \
  --json-output /tmp/workbench.json --markdown-output /tmp/workbench.md
```

The workbench rejects unbound or malformed freshness, monitor, candidate, and approval artifacts, including unknown/duplicate IDs and hash/date/state mismatches. Candidate approvals bind both the canonical hash and deterministic candidate-bundle hash. The full freshness review set is retained in JSON while Markdown remains a bounded preview. Source outcome counts and degraded monitoring state are prominent in JSON, Markdown, and the scheduled job summary. Signals remain separate and produce reviewer actions rather than a quality/safety score; the workbench does not infer validity, eligibility, service scope, test-call status, or real-time availability.

Canonical publication remains exclusively behind the existing promotion candidate, explicit human approval, dry-run, and explicit apply route. These operations never mutate canonical data, candidates, approvals, or input reports. Outputs must be new paths and are never overwritten.

## Limitations

Automated fetching can be blocked, localized, stale, or misleading. Text matching can miss formatted contacts or find unrelated digits. A successful source observation means only that bounded page content was observed; it is not operational verification.
