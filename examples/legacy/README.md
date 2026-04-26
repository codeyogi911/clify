# Legacy exemplars

These exemplars were used by earlier clify versions. They are no longer
the scaffolding stencil, but are kept as reference for the simple-API case
(no auth, no pagination, no business rules).

| Exemplar | Last used | Status |
|---|---|---|
| `jsonplaceholder-cli/` | clify v0.2 | Reference only. Single-file bin, single skill. The current stencil is `examples/exemplar-cli/`, structurally inspired by `google/agents-cli`. |

The `clify validate` gate still runs against legacy exemplars (so you can
verify the older shape if you maintain a generated CLI on it), but new
generation uses the current exemplar.
