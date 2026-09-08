# CMS production dependency audit policy

Reviewed 2026-09-08; exceptions expire 2026-10-08. `npm run audit:policy` executes a fresh `npm audit --omit=dev --json`. Unavailable/malformed audit responses, new advisories, changed affected paths/versions, and expired exceptions fail CI. A successful policy check with exceptions prints **REVIEWED RESIDUAL**, never “clean.” Transitive vulnerability entries are followed to their advisory roots, including cyclic dependency chains; package names or severity levels are not blanket allowlists.

The only override is `monaco-editor > dompurify: 3.4.15`, covering the Payload UI editor's pinned dependency. The lockfile pins its registry integrity. [DOMPurify 3.4.15](https://github.com/cure53/DOMPurify/releases/tag/3.4.15) is the reviewed patched release. No Payload downgrade or `npm audit fix --force` is permitted.

Remaining reviewed risks:

- [GHSA-jg8r-5jh2-v2xj](https://github.com/advisories/GHSA-jg8r-5jh2-v2xj): `payload@3.88.0` is a **runtime** dependency with a moderate account-unlock authorization advisory and no published patch at review time. This installation explicitly sets `Users.access.unlock = isAdmin`; real REST tests verify that members, staff, service credentials and anonymous users cannot unlock a target. This is a configuration mitigation, not a patched package or tooling-only exemption. Upgrade when Payload publishes a fix, rerun auth regressions, and remove the exception.
- [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99): `@esbuild-kit/core-utils/node_modules/esbuild@0.18.20`, reached through Payload/Drizzle migration tooling. It concerns esbuild's development server. The production command starts Next, not `esbuild.serve`; do not expose a development server. The affected package remains in the production dependency graph, so `--omit=dev` does not remove the finding. Remove the exception when the upstream toolchain upgrades it.

The executable exception table is in `cms/scripts/audit-policy.mjs`. Renewals require review of the exact advisory, installed path/version, deployment behavior, and mitigation tests; do not extend an expiry just to make CI green. Audit counts may change; unrelated low-severity findings also fail the policy.
