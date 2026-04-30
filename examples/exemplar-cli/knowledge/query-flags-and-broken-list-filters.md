---
type: contract
source: clify v0.6
applies-to: ["bin/<api>-cli.mjs", "commands/*.mjs", "lib/quirks.mjs", "lib/help.mjs", "lib/args.mjs"]
---

# `queryFlags` and `brokenListFilters` action annotations

Two **opt-in** action-def annotations let generated CLIs handle common
upstream-API quirks without per-resource glue code in `bin/`. The
substrate (`lib/quirks.mjs` + the bin runtime) is generic and dormant
unless a resource declares either annotation — the exemplar itself does
NOT use them.

## `queryFlags` — convert-from-X creates

Some APIs document a "convert from X" mode on a `POST` create where the
parent foreign key is a **URL query parameter**, not a body field. Putting
the FK in the JSON body is silently dropped — the resulting record has no
structural link back to the source. The canonical example is Zoho:

```
POST /creditnotes ?invoice_id=<INV>   ← convert-from-invoice mode (UI-equivalent)
POST /creditnotes  + body invoice_id  ← invoice_id stays null on the resulting CN
```

Mark the flag in the action def:

```js
create: {
  method: "POST",
  path: "/creditnotes",
  flags: { invoiceId: { type: "string", description: "Source invoice id (URL query)" }, ... },
  queryFlags: ["invoiceId"],
}
```

The runtime in `bin/<api>-cli.mjs`:
- Strips `queryFlags` keys from the body before calling `buildPayload`.
- Routes them onto the URL via `apiRequest.query`.
- Verify with `--dry-run`: `__dryRun.url` contains `?invoiceId=…` and
  `__dryRun.body` does NOT contain `invoiceId`.

## `brokenListFilters` — silently-ignored list filters

Some `GET …/list` endpoints accept filter query parameters that the server
silently ignores: `200 OK`, no error header, full unfiltered list returned.
**Detection requires per-flag probing** — running one probe with the
wrong name and blanket-marking the rest is the v0.5 anti-pattern this
contract exists to prevent.

### Discovery checklist (per list endpoint)

When generating or auditing a CLI:

1. **Read the docs page properly.** Every documented query-parameter
   becomes its own flag, **using the documented name verbatim**:
   `--customer_name_startswith`, `--customer_name_contains`,
   `--reference_number_startswith`, `--filter_by`, `--date_start`,
   `--date_end`. Do NOT collapse variants — the suffix (`_startswith`,
   `_contains`) is the server-side match mode and is not optional.
2. **Surface enum values.** When the docs say a param accepts an enum
   (e.g. `filter_by: All|NotShipped|Shipped|Delivered`), set
   `flags.<name>.enum: [...]` AND mention the allowed values in
   `description`. The exemplar's help generator renders inline:
   `--filter_by <All|NotShipped|Shipped|Delivered>`. The bin runtime
   rejects out-of-enum values with a `validation_error`.
3. **Auto-emit `sort_column` + `sort_order`** for any list endpoint
   whose docs mention sorting. Most paginated APIs (Zoho, Shopify,
   Stripe-style) accept these even when not tabled.
4. **Per-flag probe** (when the API can be reached at generation time):
   - Make one unfiltered call → record `baselineCount` (response row count).
   - For each filter, make one call with a value sampled from the
     unfiltered response (or the first enum value).
   - Record `filteredCount`.
   - Status:
     - `filteredCount < baselineCount` → `verified` (server honored it).
     - `filteredCount === baselineCount` → `broken` (server ignored it).
     - probe failed (no creds, network blocked, rate limit) → `untested`.
       Leave the flag working; do NOT add to `brokenListFilters`.
5. **Write the probe log to `.clify.json.filterProbes`** — one entry per
   filter probed (or skipped). The validator's `filter-coverage` check
   reads this:
   - List action declares filter-shaped flags but `filterProbes` has
     zero entries for that resource → HARD-FAIL.
   - Every filter on a list action is in `brokenListFilters` AND
     `filterProbes` shows no individual probes → HARD-FAIL (the
     blanket-mark anti-pattern).
   - Filter is `untested` → WARN, not fail.

For each filter the probe marked `broken`, declare it in
`brokenListFilters` on the action def. The v0.6+ form takes
per-filter `match` modes so the client-side fallback mirrors the
documented match semantics:

```js
list: {
  method: "GET",
  path: "/orders",
  flags: {
    customer_name_startswith: { type: "string", description: "Filter by customer name prefix (BROKEN upstream — client-side fallback)" },
    filter_by: { type: "string", enum: ["All", "Shipped", "NotShipped"], description: "Status filter (BROKEN upstream)" },
  },
  brokenListFilters: [
    { name: "customer_name_startswith", match: "startswith" },
    { name: "filter_by", match: "equals" },
  ],
}
```

(The legacy v0.5 string-list form `brokenListFilters: ["customer_name"]` is
still accepted and defaults to `match: "equals"` — but new generations
should use the object form so the fallback semantics match the docs.)

Runtime behavior when the user passes a broken filter:
1. Strip the filter from the wire query.
2. Pull the full list via cursor pagination.
3. Filter client-side with the per-filter `match` mode (`equals`,
   `startswith`, `contains`).
4. Write a one-line `note: …` to stderr.

Cost goes up to the full-list response size. For small datasets this is
trivial; for larger ones, callers should pull once and filter themselves.

### Worked example: Zoho Inventory `packages list`

Docs declare nine query parameters: `filter_by` (enum), `customer_name_startswith`,
`customer_name_contains`, `reference_number_startswith`, `reference_number_contains`,
`date_start`, `date_end`, `sort_column`, `sort_order`. The pre-v0.6 generator
collapsed these into a bare `--status`, probed once, saw the API ignore `status`,
and marked all nine as broken.

Correct generation:
- Emit each flag verbatim.
- Probe `--filter_by Shipped` → `filteredCount=83 vs baselineCount=319` → `verified`.
- Probe `--customer_name_startswith Acme` → `filteredCount=12 vs 319` → `verified`.
- Probe `--status Shipped` (if mistakenly emitted) → `filteredCount=319` → `broken`.
- `.clify.json.filterProbes` records all nine — verified or broken or untested.
- Only the genuinely-broken ones land in `brokenListFilters` with the right
  `match` mode.

A new clify version should re-run these probes whenever the upstream
docs change (`clify sync-check` flags doc drift; the manual probe is the
final word on filter behavior).
