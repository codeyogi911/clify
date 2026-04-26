---
name: exemplar-cli-knowledge
description: Capture and consult business rules and runtime quirks for the Exemplar API. Use when the user asks "what are the gotchas with this API?" or wants to record a finding that should persist across sessions.
allowed-tools:
  - Read
  - Write
---

# exemplar-cli-knowledge

API knowledge for Exemplar lives under `knowledge/`. Each file has YAML frontmatter and a free-form body.

## When to read

Before any non-trivial workflow, read every file in `knowledge/`. The files are small by design — meant to be read in full, not searched.

## When to write

After a workflow surfaces a non-obvious finding (an undocumented constraint, a sequencing requirement, a plan-tier limit, an enum value not in the OpenAPI spec), append a new file. Filename: `knowledge/<short-topic>.md`. Frontmatter:

```yaml
---
type: gotcha | pattern | shortcut | quirk | business-rule
applies-to: ["items.create", "orders.upload"]   # optional but useful
source: docs | runtime
confidence: high | medium | low
extracted: 2026-04-26
---
```

Body: prose. Cite the surface that produced the finding (response message, dashboard string, runtime error). Don't include API secrets.

## Existing knowledge

| File | Type | Applies to |
|---|---|---|
| `knowledge/idempotency-keys.md` | business-rule | `items.create`, `orders.create` |
| `knowledge/cursor-pagination.md` | pattern | every list action |
| `knowledge/rate-limit.md` | pattern | every request |
| `knowledge/composite-orders.md` | business-rule | `orders.create` |

## Anti-patterns

- ❌ Don't write nuance prose into `knowledge/` if the corresponding `.clify.json.nuances.*` field isn't set; the validation gate cross-references them.
- ❌ Don't duplicate help text — the CLI's `--help` is the source of truth for flag shapes.
- ❌ Don't keep stale entries. When the API changes (`clify sync-check` reports drift), prune knowledge that no longer applies.
