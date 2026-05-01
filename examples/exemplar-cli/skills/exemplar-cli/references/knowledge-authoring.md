# Knowledge authoring (Exemplar)

Bundled API notes live under `references/knowledge/`. Each file may use YAML frontmatter and a short body.

## When to read

Before any non-trivial workflow, read every file in `references/knowledge/`. Files are small — meant to be read in full.

## When to write

After a run surfaces a non-obvious constraint, sequencing rule, or undocumented enum, add `knowledge/<short-topic>.md` at the **repo root** (source of truth), then run `npm run sync:skill-knowledge` to refresh `references/knowledge/`.

Suggested frontmatter:

```yaml
---
type: gotcha | pattern | shortcut | quirk | business-rule
applies-to: ["items.create", "orders.upload"]   # optional
source: docs | runtime
confidence: high | medium | low
extracted: 2026-04-26
---
```

Body: cite the surface that produced the finding. Never store API secrets.

## Anti-patterns

- ❌ Don't write prose here if the matching `.clify.json.nuances.*` entry is missing — the gate cross-references them.
- ❌ Don't duplicate `--help` flag shapes — generated help is authoritative.
- ❌ Prune stale notes when the API drifts (`clify sync-check`).
