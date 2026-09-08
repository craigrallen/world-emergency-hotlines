# CMS production dependency audit policy

Reviewed 2026-09-08; exceptions expire 2026-10-08. `npm run audit:policy` executes a fresh `npm audit --omit=dev --json`. Unavailable/malformed audit responses, new advisories, changed affected paths/versions, and expired exceptions fail CI. A successful policy check with exceptions prints **REVIEWED RESIDUAL**, never “clean.” Transitive vulnerability entries are followed to their advisory roots, including cyclic dependency chains; package names or severity levels are not blanket allowlists.

The existing override is `monaco-editor > dompurify: 3.4.15`, covering the Payload UI editor's pinned dependency. The lockfile pins its registry integrity. [DOMPurify 3.4.15](https://github.com/cure53/DOMPurify/releases/tag/3.4.15) is the reviewed patched release. No Payload downgrade or `npm audit fix --force` is permitted.

A scoped `@esbuild-kit/core-utils > esbuild: 0.25.12` override replaces the migration toolchain’s vulnerable `esbuild@0.18.20`. Core-utils now deduplicates to the existing root `esbuild@0.25.12`; the lockfile change removes only the obsolete nested esbuild package/platform entries. The exact `yaml@2.9.0` development dependency satisfies Vite's optional peer without allowing the unrelated `yaml@1.10.3` used by Payload UI tooling to masquerade as a valid match under newer npm versions. `npm run verify:dependencies` enforces both trees in CI. GHSA-67mh-4wv8-2f99 is no longer an accepted exception; a recurrence fails the executable policy.

Remaining reviewed risk:

- [GHSA-jg8r-5jh2-v2xj](https://github.com/advisories/GHSA-jg8r-5jh2-v2xj): `payload@3.88.0` is a **runtime** dependency with a moderate account-unlock authorization advisory and no published patch at review time. This installation explicitly sets `Users.access.unlock = isAdmin`; real REST tests verify that members, staff, service credentials and anonymous users cannot unlock a target. This is a configuration mitigation, not a patched package or tooling-only exemption. Upgrade when Payload publishes a fix, rerun auth regressions, and remove the exception.

The executable exception table is in `cms/scripts/audit-policy.mjs`. Renewals require review of the exact advisory, installed path/version, deployment behavior, and mitigation tests; do not extend an expiry just to make CI green. Audit counts may change; unrelated low-severity findings also fail the policy.
