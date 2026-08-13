# Public release changelog

The machine-readable source for this changelog is [`releases.json`](releases.json). It is append-only and records only factual, already-delivered public milestones. It is not an incident log, deployment ledger, availability report, or semantic-version promise.

## Entry contract

Each entry has a stable `id`, valid ISO `date`, short `title`, and a non-empty list of factual `facts`. Entries are newest first; IDs must not duplicate, while multiple milestones may share a date. Automated verification checks the schema, ordering, duplicate IDs, conservative claims, and that the public `/releases` page renders directly from the JSON source. Add an entry only after the capability is public in repository history; do not generate entries from commit subjects without review.

The current seeded milestones are rendered at <https://worldhotlines.org/releases>.
