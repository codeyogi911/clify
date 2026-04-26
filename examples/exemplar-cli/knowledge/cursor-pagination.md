---
type: pattern
source: docs
extracted: 2026-04-26
confidence: high
applies-to: ["items.list", "item-variants.list", "orders.list"]
---

Every `list` action paginates via opaque cursors. Response shape:

```json
{ "items": [ ... ], "nextCursor": "<opaque-string>" | null }
```

When `nextCursor` is null or absent, iteration is complete. Otherwise pass it back as `--cursor <value>` to fetch the next page.

The CLI's `--all` flag automates this loop — it concatenates pages and emits the combined array. Use `--all` for small/medium datasets where you want the whole list in memory; for very large datasets, page manually with `--cursor` so you can checkpoint between batches.

Cursors are not stable across schema migrations: a cursor obtained yesterday may return `400 validation_error` today. Treat cursors as ephemeral within a session.
