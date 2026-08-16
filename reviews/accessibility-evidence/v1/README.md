# Internal accessibility regression evidence baseline

Internal-only marker: `internal-accessibility-evidence-only/v1`.

This directory contains a deterministic, repository-internal baseline for selected static accessibility properties of `/find-help`, `/traveler`, `/widget`, `/widget/v1/hotlines-widget.js`, and `/language-status`.

The finite review boundary is defined in `baseline.json`: every file under `web/src/` and `web/scripts/` (excluding interpreter caches), canonical `hotlines.json`, the widget source, Astro/PostCSS/Tailwind/TypeScript configuration, and the package manifest and lockfile. The update command prints its complete sorted inventory, and the manifest records its file count and a length-framed SHA-256 digest binding the exact paths and bytes. Built HTML is checked structurally with parse5; widget shell structure is constructed in a dependency-free VM DOM harness. Built output hashes are deliberately not claimed to be reproducible.

The verifier checks that complete boundary, a closed duplicate-free manifest, built HTML structure, and VM-observed widget construction. Assertion names describe only those static facts. A passing result is factual regression evidence only. It does not claim WCAG conformance, certification, VPAT or ACR status, exhaustive assistive-technology coverage, legal compliance, or external assessor review.

Manual entries are deliberately `pending` or `not_assessed`. Static inspection cannot establish real keyboard behavior, computed focus or RTL styling in supported browsers, screen-reader announcements, contrast, zoom/reflow behavior, translation quality, dark-theme outcomes, or host-page/widget combinations.

From `web/`, run `npm run update:accessibility-evidence-sources` after intentionally reviewing every boundary change. The command first prints one copy-ready `"sources": {...},` line: replace only the existing `sources` member in `baseline.json` with that line. After a blank line it prints the complete sorted inventory for review; the inventory is informational and must not be pasted into the manifest. Run `npm run test:accessibility-evidence` for adversarial fixtures and `npm run verify:accessibility-evidence` for the build plus verifier. The artifact remains under `reviews/`, which is excluded from the Docker build context; nonpublication scans stable markers and exact hashes of every file in this evidence directory.
