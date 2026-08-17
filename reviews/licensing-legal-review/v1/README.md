# Internal licensing legal-review handoff v1

`index.json` is a repository-internal, nonpublication index for a future review by qualified counsel. It is not legal advice, a legal opinion, permission, approval, or a licensing decision. No legal review, counsel contact, or approval has occurred.

Every outcome is `held`. The index separates code, data, brand, contributions, hosted/commercial rights, and provenance questions. Repository evidence is byte-bound in `sources`; the external decision pack is represented only by its expected basename and SHA-256. It is deliberately not copied into this repository, and CI never depends on its machine-local path.

Run from `web/`:

```sh
npm run verify:licensing-legal-review
```

To compare an authorized local copy of the external pack without making it a CI dependency:

```sh
node scripts/verify-licensing-legal-review.mjs --external-pack /absolute/path/licensing-decision-pack-2026-08-13.md
```

The verifier uses strict JSON parsing, a closed Draft 2020-12 schema, immutable runtime inventories, no-follow tracked-file reads, Git-index/worktree equality, stable path and whole-index checks, and exact repository-evidence hashes. `reviews/` remains excluded from the Docker context, and the shared nonpublication verifier scans built output for internal markers, exact artifact bytes, semantic sections, and distinctive scalar leaks.

The index must not be used to choose or apply a license, add license terms, describe the project as open source/open data, engage counsel, contact a source or rights holder, negotiate terms, publish pricing, create a contract, start billing, promise an SLA/DPA, make a security assurance, or activate any customer/commercial workflow. Those actions require separate authority outside this artifact.
